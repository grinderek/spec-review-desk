import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultChangeName, resumeAuthor, slugify, startAuthor } from './author-run.ts'
import { dismissDecision } from './decision-model.ts'
import { EventBus } from './events.ts'
import { git } from './git.ts'
import { type InitiativeDoc, readInitiative, updateInitiative, upsertRun } from './initiative-store.ts'
import { readReview, updateReview } from './review-store.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService } from './run-service.ts'
import { FAKE_OPENSPEC, resetFakeClaude } from './testing/fake-claude-path.ts'
import { FakeSandbox } from './testing/fake-sandbox.ts'
import { FEATURE, NEW_STEPS_MD, SPEC_MD } from './testing/fixtures.ts'
import { testConfig } from './testing/http.ts'
import { INITIATIVE_AT, makeInitiative } from './testing/initiative.ts'
import { makeRepo } from './testing/repo.ts'

const CHANGE = 'add-hs-email-inputs'
const KEY = "features/thread_state.feature::The founder's reply resolves a waiting thread"
const plan: InitiativeDoc['plan'] = {
  status: 'approved',
  approved_at: INITIATIVE_AT,
  slices: [
    { id: 's1', title: 'Email inputs', scope: 'Threads from Gmail.', depends_on: [], change: null },
    { id: 's2', title: 'Calendar', scope: 'Meetings.', depends_on: ['s1'], change: null },
  ],
}
const option = (id: string) => ({ id, label: id, consequence: `${id}.` })
const reply = (over: Record<string, unknown> = {}) => ({ answer: 'Wrote the email slice.', patch: null, decisions: [], resolves: [], status: 'done', change: CHANGE, ...over })
const files = (change = CHANGE): Record<string, string> => ({
  [`openspec/changes/${change}/.openspec.yaml`]: 'schema: behavior-driven\ncreated: 2026-09-24\n',
  [`openspec/changes/${change}/proposal.md`]: '## Why\n\nEmail.\n',
  [`openspec/changes/${change}/specs/thread-state/spec.md`]: SPEC_MD,
  [`openspec/changes/${change}/features/thread_state.feature`]: FEATURE,
  [`openspec/changes/${change}/features/NEW_STEPS.md`]: NEW_STEPS_MD,
})
let tmp = ''

async function setup() {
  const { repo } = await makeRepo()
  const { wt, ini, dir } = await makeInitiative(repo, { plan })
  const sandbox = new FakeSandbox()
  const service = new InitiativeRunService({ config: testConfig(repo, { openspecBin: FAKE_OPENSPEC }), bus: new EventBus(), sandbox, finishers: FINISHERS })
  return { repo, wt, ini, dir, sandbox, service, target: { wt, ini } }
}
async function writes(entries: { match: string; files: Record<string, string> }[]): Promise<void> {
  const file = path.join(tmp, 'writes.json')
  await writeFile(file, JSON.stringify(entries))
  process.env.FAKE_CLAUDE_WRITES_FILE = file
}

beforeEach(async () => {
  resetFakeClaude()
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-author-'))
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_MODE = 'answer'
  process.env.FAKE_OPENSPEC_LOG = path.join(tmp, 'openspec.ndjson')
  delete process.env.FAKE_OPENSPEC_FAIL
})

describe('author runs', () => {
  it('vets the output, moves the change, writes its review.yaml with the decisions and commits once', async () => {
    const s = await setup()
    const decision = { id: 'partial', question: 'Count partial days?', scope: { kind: 'scenario', key: KEY }, options: [option('yes'), option('no')], recommended: 'yes', blocking: false }
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply({ decisions: [decision] }))
    await writes([{ match: 'Slice s1', files: files() }])
    const run = await startAuthor(s.service, s.target, 's1', { notes: 'Keep it small.', change: CHANGE })
    await s.service.settled(run.id)

    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ kind: 'author', slice: 's1', change: CHANGE, outcome: 'done' })
    expect(doc.plan.slices[0]!.change).toBe(CHANGE)
    const changeDir = path.join(s.repo, 'openspec/changes', CHANGE)
    expect(await readFile(path.join(changeDir, 'features/thread_state.feature'), 'utf8')).toBe(FEATURE)
    expect((await readReview(changeDir)).decisions[0]).toMatchObject({ agent_id: 'partial', source: { kind: 'run', run: run.id, agent: 'author' }, scope: { kind: 'scenario', key: KEY } })
    expect((await git(s.repo, ['log', '-1', '--format=%s'])).trim()).toBe(`docs(openspec): ${CHANGE} — slice s1 executable Gherkin (clean room)`)
    const committed = (await git(s.repo, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n')
    expect(committed).toContain(`openspec/changes/${CHANGE}/review.yaml`)
    expect(committed).toContain('openspec/initiatives/hs/initiative.yaml')
    expect((await git(s.repo, ['status', '--porcelain'])).trim()).toBe('')
    expect(s.sandbox.runs[0]).toMatchObject({ extraArgs: ['--add-dir', '/work/out'] })
    expect(s.sandbox.runs[0]!.claude).toMatchObject({ allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], permissionMode: 'acceptEdits' })
    expect(s.sandbox.runs[0]!.claude.prompt).toContain('Owner notes: Keep it small.')
  })

  it('moves nothing when the output fails vetting', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    await writes([{ match: 'Slice s1', files: { ...files(), 'openspec/changes/other/proposal.md': 'x' } }])
    const run = await startAuthor(s.service, s.target, 's1', {})
    await s.service.settled(run.id)
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'failed', problems: [`the output must contain only openspec/changes/${CHANGE}/ — found openspec/changes/other`] })
    expect(doc.plan.slices[0]!.change).toBeNull()
    await expect(stat(path.join(s.repo, 'openspec/changes', CHANGE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a decision about a scenario the change does not have', async () => {
    const s = await setup()
    const decision = { id: 'x', question: 'Q?', scope: { kind: 'scenario', key: 'features/nope.feature::Nope' }, options: [option('a'), option('b')], recommended: null, blocking: false }
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply({ decisions: [decision] }))
    await writes([{ match: 'Slice s1', files: files() }])
    const run = await startAuthor(s.service, s.target, 's1', {})
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]!.problems).toEqual([`decisions[0].scope.key: no scenario "features/nope.feature::Nope" in ${CHANGE}`])
  })

  it('stops for the owner, resumes the same session once the blocking decisions are closed, then finishes', async () => {
    const s = await setup()
    const blocking = { id: 'basis', question: 'Business or calendar age?', scope: { kind: 'change' }, options: [option('business'), option('calendar')], recommended: 'business', blocking: true }
    await writeFile(path.join(tmp, 'replies.json'), JSON.stringify([
      { match: 'Continue writing the change', reply: reply() },
      { match: 'Slice s1', reply: reply({ status: 'needs_owner', answer: 'Need the age basis.', decisions: [blocking] }) },
    ]))
    process.env.FAKE_CLAUDE_REPLIES_FILE = path.join(tmp, 'replies.json')
    await writes([{ match: 'Continue writing the change', files: files() }])
    const run = await startAuthor(s.service, s.target, 's1', {})
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', notes: 'Need the age basis.' })
    const [raised] = (await readReview(s.dir)).decisions
    expect(raised).toMatchObject({ source: { kind: 'run', run: run.id, agent: 'author' }, blocking: true, status: 'open' })
    expect(s.sandbox.cleaned).toEqual([])
    await expect(resumeAuthor(s.service, s.target, run.id)).rejects.toMatchObject({ code: 'decisions_pending' })

    await updateReview(s.dir, (d) => dismissDecision(d, raised!.id, 'Use business hours.', INITIATIVE_AT))
    await resumeAuthor(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done' })
    const second = s.sandbox.runs[1]!
    expect(second.claude).toMatchObject({ resume: true, sessionId: run.session })
    expect(second.claude.prompt).toContain(`- ${raised!.id} (Business or calendar age?): dismissed — Use business hours.`)
    expect(second.room).toBe(s.sandbox.runs[0]!.room)
  })

  it('refuses a slice that is not ready, a second author, a bad or taken change name', async () => {
    const s = await setup()
    await expect(startAuthor(s.service, s.target, 's2', {})).rejects.toMatchObject({ code: 'slice_not_ready', message: 's2 cannot be proposed: waiting for s1' })
    await expect(startAuthor(s.service, s.target, 's1', { change: 'Bad Name' })).rejects.toMatchObject({ code: 'invalid_change_name' })
    await expect(startAuthor(s.service, s.target, 's1', { change: 'add-thread-state' })).rejects.toMatchObject({ code: 'change_exists' })
    await updateInitiative(s.dir, (d) => upsertRun(d, {
      id: 'r_00000001', kind: 'author', slice: 's9', topic: null, session: 's', container: 'sr-r_00000001', log: '.spec-review/runs/r_00000001.ndjson', started_at: INITIATIVE_AT, ended_at: null, outcome: 'running', notes: null,
    }))
    await expect(startAuthor(s.service, s.target, 's1', {})).rejects.toMatchObject({ code: 'author_running' })
  })

  it('starts one author when Propose is pressed twice at once', async () => {
    const s = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    await writes([{ match: 'Slice s1', files: files() }])
    const results = await Promise.allSettled([startAuthor(s.service, s.target, 's1', {}), startAuthor(s.service, s.target, 's1', {})])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(rejected.reason).toMatchObject({ code: 'author_running' })
    const started = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startAuthor>>> => r.status === 'fulfilled')!
    await s.service.settled(started.value.id)
    expect((await readInitiative(s.dir)).runs).toHaveLength(1)
  })

  it('names the change after the initiative and the slice title, unique in the worktree', async () => {
    const s = await setup()
    expect(slugify('Email — inputs, ÜBER 2!')).toBe('email-inputs-uber-2')
    expect(await defaultChangeName(s.wt, 'hs', 'Email inputs')).toBe('add-hs-email-inputs')
    expect(await defaultChangeName(s.wt, 'thread', 'State')).toBe('add-thread-state-2')
  })
})
