import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { EventBus } from './events.ts'
import { git } from './git.ts'
import { REPLY_SCHEMA_ARGS } from './initiative-protocol.ts'
import { INITIATIVE_FILE, InitiativeFileError, readInitiative, type RunRecord, updateInitiative, upsertRun } from './initiative-store.ts'
import { startPlanner } from './planner-run.ts'
import { readReview } from './review-store.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService, runPaths } from './run-service.ts'
import type { RunOptions, SandboxOutcome, SandboxRun } from './sandbox.ts'
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

async function setup(sandbox: FakeSandbox = new FakeSandbox()) {
  const { repo } = await makeRepo()
  const { wt, ini, dir } = await makeInitiative(repo)
  const bus = new EventBus()
  const events: { topic: string; data: unknown }[] = []
  bus.subscribe('*', (e) => events.push(e))
  const service = new InitiativeRunService({ config: testConfig(repo), bus, sandbox, finishers: FINISHERS })
  return { repo, wt, ini, dir, sandbox, service, events, target: { wt, ini } }
}
// Emits a raw stream_event line as the fake CLI would, for scripted-sandbox tests that need exact
// control over how the stream is chunked (review round 3's leak.mts reproduction).
const streamEvent = (event: unknown): string => JSON.stringify({ type: 'stream_event', event, session_id: 's' })
const resultEvent = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: 's', ...over })
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
    expect(spec).toMatchObject({ runId: run.id, domains: [], extraArgs: [], browser: false })
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

  it('redacts a secret split across narration AND thinking fragments, leaking nowhere: log file, log(), the bus, or initiative.yaml (review round 3, finding 1)', async () => {
    const chunks = FAKE_TOKEN.match(/.{1,6}/g) ?? []
    class Scripted extends FakeSandbox {
      override run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
        this.runs.push(spec)
        opts.onLine(streamEvent({ type: 'message_start', message: { id: 'm' } }))
        for (const c of chunks) opts.onLine(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }))
        for (const c of chunks) opts.onLine(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: c } }))
        opts.onLine(resultEvent())
        return Promise.resolve({ code: 0, timedOut: false, stopped: false, error: null })
      }
    }
    const s = await setup(new Scripted())
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    const prefix = FAKE_TOKEN.slice(0, 8)
    const logText = await readFile(path.join(s.repo, run.log), 'utf8')
    expect(logText).not.toContain(FAKE_TOKEN)
    expect(logText).not.toContain(prefix)
    const served = await s.service.log(s.target, run.id)
    expect(served.text).not.toContain(FAKE_TOKEN)
    expect(served.text).not.toContain(prefix)
    const published = JSON.stringify(s.events.filter((e) => e.topic === `irun:${run.id}`))
    expect(published).not.toContain(FAKE_TOKEN)
    expect(published).not.toContain(prefix)
    const iniText = JSON.stringify(doc)
    expect(iniText).not.toContain(FAKE_TOKEN)
    expect(iniText).not.toContain(prefix)
  })

  it('detects a token hidden behind \\u escapes in the terminal result line (review round 3, minor)', async () => {
    // The token's bytes never appear literally on the wire — each character is a \u escape, decoded
    // to its literal form only once the line is JSON.parsed.
    const escaped = [...FAKE_TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
    class Scripted extends FakeSandbox {
      override run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
        this.runs.push(spec)
        opts.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
        opts.onLine(
          `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok",` +
            `"structured_output":{"answer":"${escaped}","patch":null,"decisions":[],"resolves":[],"status":"done"},"session_id":"s"}`,
        )
        return Promise.resolve({ code: 0, timedOut: false, stopped: false, error: null })
      }
    }
    const s = await setup(new Scripted())
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    const prefix = FAKE_TOKEN.slice(0, 8)
    const iniText = JSON.stringify(doc)
    expect(iniText).not.toContain(FAKE_TOKEN)
    expect(iniText).not.toContain(prefix)
  })

  // Review round 5 (leak6 "I", leak7 "K"): sub-8-character pieces interleaved with another stream
  // must still fail the run through the run-wide detector — the answer pieces arrive \u-escaped in
  // the raw JSON, and tool names are a stream of their own. " done." keeps the end-of-text check out.
  const PIECES8 = Array.from({ length: FAKE_TOKEN.length - 7 }, (_, i) => FAKE_TOKEN.slice(i, i + 8))
  async function interleaved(lines: string[]) {
    class Scripted extends FakeSandbox {
      override run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
        this.runs.push(spec)
        for (const l of lines) opts.onLine(l)
        return Promise.resolve({ code: 0, timedOut: false, stopped: false, error: null })
      }
    }
    const s = await setup(new Scripted())
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    expect(doc.runs[0]!.notes).toContain('claude setup-token')
    expect(doc.plan.status).toBe('none')
    const surfaces = [
      await readFile(path.join(s.repo, run.log), 'utf8'), (await s.service.log(s.target, run.id)).text,
      JSON.stringify(s.events.filter((e) => e.topic === `irun:${run.id}`)), JSON.stringify(doc),
    ]
    for (const text of surfaces) {
      expect(text).not.toContain(FAKE_TOKEN)
      expect(PIECES8.filter((p) => text.includes(p))).toEqual([])
    }
  }
  const pieces6 = FAKE_TOKEN.match(/.{1,6}/g) ?? []
  const narrationLine = (text: string) => streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })

  it('fails a token interleaved narration <-> \\u-escaped answer JSON in pieces under 8 characters (review round 5, I)', async () => {
    const odd = `${pieces6.filter((_, i) => i % 2 === 1).join('')} ok.`
    const full = JSON.stringify(reply({ answer: odd }))
    const head = '{"answer":"'
    const esc = (p: string) => `\\u${p.charCodeAt(0).toString(16).padStart(4, '0')}${p.slice(1)}`
    const json = (partial: string) => streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } })
    const lines = [streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'StructuredOutput', id: 't' } }), json(head)]
    pieces6.forEach((p, i) => lines.push(i % 2 ? json(esc(p)) : narrationLine(p)))
    lines.push(narrationLine(' done.'), json(` ok.${full.slice(head.length + odd.length)}`))
    await interleaved([...lines, resultEvent({ structured_output: reply({ answer: odd }) })])
  })

  it('fails a token interleaved narration <-> tool names in pieces under 8 characters (review round 5, K)', async () => {
    const lines = pieces6.map((p, i) => (i % 2
      ? streamEvent({ type: 'content_block_start', index: 10 + i, content_block: { type: 'tool_use', name: p, id: `x${i}` } })
      : narrationLine(p)))
    await interleaved([...lines, narrationLine(' done.'), resultEvent({ structured_output: reply() })])
  })

  it('redacts a secret in the container error before it reaches the run notes (review Important #2)', async () => {
    const s = await setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    s.sandbox.run = async () => ({ code: 1, timedOut: false, stopped: false, error: `container crashed: ${FAKE_TOKEN}` })
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    // Round 4: a secret in the container error fails the run as a secret, before any notes are built from it.
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: ['a secret appeared in the agent output'] })
    expect(doc.runs[0]!.notes).not.toContain(FAKE_TOKEN)
    expect(doc.runs[0]!.notes).toContain('claude setup-token')
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

  it('starts without the research browser image (controller ruling 1)', async () => {
    const s = await setup()
    s.sandbox.statusValue = { ...s.sandbox.statusValue, browserImage: false, browserFix: 'Build the research browser image: npm run agent:build' }
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    const run = await startPlanner(s.service, s.target)
    await s.service.settled(run.id)
    expect(s.sandbox.runs).toHaveLength(1)
    expect(s.sandbox.runs[0]!.browser).toBe(false)
  })

  it('refuses without a ready sandbox, after approval and while a planner runs', async () => {
    const s = await setup()
    s.sandbox.statusValue = { ...s.sandbox.statusValue, image: false, ready: false, fixes: ['Build the sandbox images: npm run agent:build'] }
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'sandbox_unavailable', message: expect.stringContaining('npm run agent:build') })
    const running: RunRecord = {
      id: 'r_00000009', kind: 'planner', slice: null, topic: null, session: 's', container: 'sr-r_00000009', log: '.spec-review/runs/r_00000009.ndjson',
      started_at: INITIATIVE_AT, ended_at: null, outcome: 'running', notes: null,
    }
    await updateInitiative(s.dir, (d) => upsertRun(d, running))
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'planner_running' })
    await updateInitiative(s.dir, (d) => ({ ...d, runs: [], plan: { status: 'approved', approved_at: INITIATIVE_AT, slices: [] } }))
    await expect(startPlanner(s.service, s.target)).rejects.toMatchObject({ code: 'plan_approved' })
  })

  it('marks runs left running by an earlier Desk as failed and cleans them up (ruling 7)', async () => {
    const s = await setup()
    const stale: RunRecord = {
      id: 'r_0000dead', kind: 'author', slice: 's1', topic: null, session: 's', container: 'sr-r_0000dead', log: '.spec-review/runs/r_0000dead.ndjson',
      started_at: INITIATIVE_AT,
      ended_at: null, outcome: 'running', notes: null,
    }
    const waiting: RunRecord = { ...stale, id: 'r_0000beef', log: '.spec-review/runs/r_0000beef.ndjson', outcome: 'needs_owner' }
    await updateInitiative(s.dir, (d) => upsertRun(upsertRun(d, stale), waiting))
    await mkdir(runPaths(s.wt, waiting).sessions, { recursive: true })
    await s.service.failStale(s.target)
    const runs = (await readInitiative(s.dir)).runs
    expect(runs[0]).toMatchObject({ outcome: 'failed', notes: 'The Desk restarted while this run was running.' })
    expect(runs[1]).toMatchObject({ id: 'r_0000beef', outcome: 'needs_owner' })
    expect(s.sandbox.cleaned).toEqual(['r_0000dead'])
    expect((await stat(runPaths(s.wt, waiting).sessions)).isDirectory()).toBe(true)
  })
  it('never cleans up a run whose hand-edited id leaves the runs dir — the file is reported instead (final review I4)', async () => {
    const s = await setup()
    const victim = path.join(s.wt.path, 'victim')
    await mkdir(victim, { recursive: true })
    await writeFile(path.join(victim, 'keep.txt'), 'keep')
    const doc = await readInitiative(s.dir)
    const evil = {
      id: '../../victim', kind: 'author', slice: 's1', topic: null, session: 's', container: 'sr-x', log: '.spec-review/runs/../../victim/keep.txt',
      started_at: INITIATIVE_AT, ended_at: null, outcome: 'running', notes: null,
    }
    await writeFile(path.join(s.dir, INITIATIVE_FILE), stringify({ ...doc, runs: [evil] }))
    await expect(s.service.failStale(s.target)).rejects.toBeInstanceOf(InitiativeFileError)
    await expect(s.service.log(s.target, '../../victim')).rejects.toBeInstanceOf(InitiativeFileError)
    expect(s.sandbox.cleaned).toEqual([])
    expect(await readFile(path.join(victim, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
