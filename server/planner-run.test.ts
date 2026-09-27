import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from './events.ts'
import { git } from './git.ts'
import { REPLY_SCHEMA_ARGS } from './initiative-protocol.ts'
import { readInitiative, type RunRecord, updateInitiative, upsertRun } from './initiative-store.ts'
import { startPlanner } from './planner-run.ts'
import { readReview } from './review-store.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService, runPaths } from './run-service.ts'
import { resetFakeClaude } from './testing/fake-claude-path.ts'
import { FAKE_TOKEN, FakeSandbox } from './testing/fake-sandbox.ts'
import { testConfig } from './testing/http.ts'
import { INITIATIVE_AT, makeInitiative } from './testing/initiative.ts'
import { makeRepo } from './testing/repo.ts'

const reply = (over: Record<string, unknown> = {}) => ({
  answer: 'Two slices: the engine first.',
  patch: null,
  decisions: [{ id: 'order', question: 'Engine before email?', scope: { kind: 'change' }, options: [{ id: 'yes', label: 'Yes', consequence: 'Engine first.' }, { id: 'no', label: 'No', consequence: 'Email first.' }], recommended: 'yes', blocking: true }],
  resolves: [],
  status: 'done',
  slices: [{ title: 'Engine', scope: 'The pure engine.', depends_on: [] }, { title: 'Email', scope: 'Email inputs.', depends_on: [1] }],
  ...over,
})
let fakeLog = ''

async function setup() {
  const { repo } = await makeRepo()
  const { wt, ini, dir } = await makeInitiative(repo)
  const sandbox = new FakeSandbox()
  const bus = new EventBus()
  const events: { topic: string; data: unknown }[] = []
  bus.subscribe('*', (e) => events.push(e))
  const service = new InitiativeRunService({ config: testConfig(repo), bus, sandbox, finishers: FINISHERS })
  return { repo, wt, ini, dir, sandbox, service, events, target: { wt, ini } }
}
const calls = async () => (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string; cwd: string })

beforeEach(async () => {
  resetFakeClaude()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-planner-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_LOG = fakeLog
  process.env.FAKE_CLAUDE_MODE = 'answer'
})

describe('planner runs', () => {
  it('runs in the sandbox, writes a committed draft and raises its decisions in the initiative inbox', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    const run = await startPlanner(s.service, s.target)
    expect(run).toMatchObject({ kind: 'planner', outcome: 'running', container: `sr-${run.id}`, log: `.spec-review/runs/${run.id}.ndjson` })
    await s.service.settled(run.id)

    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ id: run.id, outcome: 'done', notes: 'Two slices: the engine first.' })
    expect(doc.plan).toEqual({ status: 'draft', approved_at: null, slices: [
      { id: 's1', title: 'Engine', scope: 'The pure engine.', depends_on: [], change: null },
      { id: 's2', title: 'Email', scope: 'Email inputs.', depends_on: ['s1'], change: null },
    ] })
    const [decision] = (await readReview(s.dir)).decisions
    expect(decision).toMatchObject({ agent_id: 'order', source: { kind: 'run', run: run.id, agent: 'planner' }, scope: { kind: 'change' }, status: 'open', blocking: true })
    expect((await git(s.repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): hs — slice plan draft')
    expect((await git(s.repo, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n').sort()).toEqual([
      'openspec/initiatives/hs/initiative.yaml', 'openspec/initiatives/hs/review.yaml',
    ])

    const [spec] = s.sandbox.runs
    expect(spec).toMatchObject({ runId: run.id, domains: [], extraArgs: [] })
    expect(spec!.claude).toMatchObject({ cwd: '/work/in', model: 'opus', allowedTools: ['Read', 'Grep', 'Glob'], permissionMode: 'default', jsonSchema: REPLY_SCHEMA_ARGS.planner })
    const [call] = await calls()
    expect(call!.prompt).toContain('Initiative: hs — Health score (repository api).')
    expect(call!.cwd).toBe(runPaths(s.wt, run).room)
    expect(s.sandbox.cleaned).toEqual([run.id])
    await expect(stat(runPaths(s.wt, run).runDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(s.repo, run.log), 'utf8')).toContain('"type":"result"')
    const streamed = s.events.filter((e) => e.topic === `irun:${run.id}`).flatMap((e) => {
      const data = e.data as { type: string; event?: { type: string; text?: string } }
      return data.event?.type === 'answer_delta' ? [data.event.text ?? ''] : []
    })
    expect(streamed.join('')).toBe('Two slices: the engine first.')
  })

  it('retries an invalid reply once in the same session', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    process.env.FAKE_CLAUDE_STRUCTURED = 'invalid-then-valid'
    process.env.FAKE_CLAUDE_INVALID_REPLY = JSON.stringify(reply({ slices: [] }))
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const [first, second] = await calls()
    expect(second!.prompt).toBe('Your reply did not pass validation: slices: the planner proposes 1 to 12 slices. Reply again with the same schema.')
    expect(second!.args).toEqual(expect.arrayContaining(['--resume', run.session]))
    expect(first!.args).toEqual(expect.arrayContaining(['--session-id', run.session]))
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', validation_retry: true })
  })

  it('fails after the second invalid reply and keeps the plan', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_STRUCTURED = 'invalid-twice'
    process.env.FAKE_CLAUDE_INVALID_REPLY = JSON.stringify(reply({ slices: [] }))
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['slices: the planner proposes 1 to 12 slices'] })
    expect(doc.plan.status).toBe('none')
  })

  it('fails a run whose output carries the token, redacts the log and moves nothing', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply({ answer: `Here: ${FAKE_TOKEN}` }))
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    expect(doc.runs[0]!.notes).toContain('claude setup-token')
    expect(doc.plan.status).toBe('none')
    const log = await readFile(path.join(s.repo, run.log), 'utf8')
    expect(log).not.toContain(FAKE_TOKEN)
    expect(log).toContain('[REDACTED]')
    // The token must never reach the live UI stream either — redaction happens per line, before
    // publish, not only in a post-hoc rewrite of the finished log (review Important #1).
    const published = JSON.stringify(s.events.filter((e) => e.topic === `irun:${run.id}`))
    expect(published).not.toContain(FAKE_TOKEN)
  })

  it('redacts a secret split across small stream chunks even when the terminal result carries no trace of it (review round 2, finding 1)', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply({ answer: `Here: ${FAKE_TOKEN}` }))
    process.env.FAKE_CLAUDE_RESULT_SAFE = '1'
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    expect(doc.plan.status).toBe('none')
    const prefix = FAKE_TOKEN.slice(0, 8)
    const log = await readFile(path.join(s.repo, run.log), 'utf8')
    expect(log).not.toContain(FAKE_TOKEN)
    expect(log).not.toContain(prefix)
    const published = JSON.stringify(s.events.filter((e) => e.topic === `irun:${run.id}`))
    expect(published).not.toContain(FAKE_TOKEN)
    expect(published).not.toContain(prefix)
    expect(doc.runs[0]!.notes).not.toContain(prefix)
  })

  it('redacts a secret in the container error before it reaches the run notes (review Important #2)', async () => {
    const s = await setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    s.sandbox.run = async () => ({ code: 1, timedOut: false, stopped: false, error: `container crashed: ${FAKE_TOKEN}` })
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]!.outcome).toBe('failed')
    expect(doc.runs[0]!.notes).not.toContain(FAKE_TOKEN)
    expect(doc.runs[0]!.notes).toContain('[REDACTED]')
    errorSpy.mockRestore()
  })

  it('redacts a secret in an exception message before it reaches the run notes (review Important #2)', async () => {
    const s = await setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    s.sandbox.run = () => { throw new Error(`crashed while spawning: ${FAKE_TOKEN}`) }
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]!.outcome).toBe('failed')
    expect(doc.runs[0]!.notes).not.toContain(FAKE_TOKEN)
    expect(doc.runs[0]!.notes).toContain('The run broke')
    expect(doc.runs[0]!.notes).toContain('[REDACTED]')
    errorSpy.mockRestore()
  })

  it('stops a running planner', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_MODE = 'hang'
    const run = await startPlanner(s.service, s.target)
    await new Promise((r) => setTimeout(r, 300))
    await s.service.stop(s.target, run.id)
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'stopped' })
    await expect(s.service.stop(s.target, run.id)).rejects.toMatchObject({ code: 'run_not_running' })
  })

  it('refuses without a ready sandbox, after approval and while a planner runs', async () => {
    const s = await setup()
    s.sandbox.statusValue = { ...s.sandbox.statusValue, image: false, ready: false, fixes: ['Build the sandbox images: npm run agent:build'] }
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'sandbox_unavailable', message: expect.stringContaining('npm run agent:build') })
    const running: RunRecord = {
      id: 'r_00000009', kind: 'planner', slice: null, topic: null, session: 's', container: 'sr-r_00000009', log: 'x', started_at: INITIATIVE_AT,
      ended_at: null, outcome: 'running', notes: null,
    }
    await updateInitiative(s.dir, (d) => upsertRun(d, running))
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'planner_running' })
    await updateInitiative(s.dir, (d) => ({ ...d, runs: [], plan: { status: 'approved', approved_at: INITIATIVE_AT, slices: [] } }))
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'plan_approved' })
  })

  it('marks runs left running by an earlier Desk as failed and cleans them up (ruling 7)', async () => {
    const s = await setup()
    const stale: RunRecord = {
      id: 'r_0000dead', kind: 'author', slice: 's1', topic: null, session: 's', container: 'sr-r_0000dead', log: 'x', started_at: INITIATIVE_AT,
      ended_at: null, outcome: 'running', notes: null,
    }
    const waiting: RunRecord = { ...stale, id: 'r_0000wait', outcome: 'needs_owner' }
    await updateInitiative(s.dir, (d) => upsertRun(upsertRun(d, stale), waiting))
    await mkdir(runPaths(s.wt, waiting).sessions, { recursive: true })
    await s.service.failStale(s.target)
    const runs = (await readInitiative(s.dir)).runs
    expect(runs[0]).toMatchObject({ outcome: 'failed', notes: 'The Desk restarted while this run was running.' })
    expect(runs[1]).toMatchObject({ id: 'r_0000wait', outcome: 'needs_owner' })
    expect(s.sandbox.cleaned).toEqual(['r_0000dead'])
    expect((await stat(runPaths(s.wt, waiting).sessions)).isDirectory()).toBe(true)
  })
})
