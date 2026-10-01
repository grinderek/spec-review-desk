import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplyService, applyPrompt, DEFAULT_APPLY_DENY, outcomeOf, readEvents, resolveRunLog } from './apply.ts'
import { listChanges, Registry, discover } from './discovery.ts'
import { EventBus } from './events.ts'
import { appendMessage, readReview, recordApproval, updateReview, upsertApplyRun } from './review-store.ts'
import { FAKE_CODEX, resetFakeCodex } from './testing/fake-codex-path.ts'
import { testConfig } from './testing/http.ts'
import { makeRepo } from './testing/repo.ts'
import { approveEverything } from './testing/review.ts'

let fakeLog = ''

async function setup(opts: { approve?: boolean; record?: boolean } = {}) {
  const { repo } = await makeRepo()
  const registry = new Registry()
  await discover([{ name: 'api', path: repo }], registry)
  const wt = registry.all()[0]!
  const ref = (await listChanges(wt))[0]!
  if (opts.approve !== false) await approveEverything(wt, ref)
  if (opts.record !== false) await updateReview(ref.dir, (d) => recordApproval(d, '2026-09-23T10:00:00.000Z', 'abc1234'))
  const bus = new EventBus()
  const events: { topic: string; data: unknown }[] = []
  bus.subscribe('*', (e) => events.push(e))
  const apply = new ApplyService({ config: testConfig(repo, { codexBin: FAKE_CODEX }), bus, pollMs: 50 })
  return { repo, wt, ref, apply, events }
}

const calls = async () => (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string })

beforeEach(async () => {
  resetFakeCodex()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-apply-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CODEX_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CODEX_LOG = fakeLog
  process.env.FAKE_CODEX_MODE = 'answer'
  process.env.FAKE_CODEX_TEXT = 'All scenarios green.'
})

describe('resolveRunLog', () => {
  it('accepts a log path under .spec-review/runs/ and rejects anything that escapes it', () => {
    const wt = '/home/x/hub-wt/api'
    expect(resolveRunLog(wt, '.spec-review/runs/r_1.ndjson')).toBe(path.join(wt, '.spec-review/runs/r_1.ndjson'))
    expect(() => resolveRunLog(wt, '../secret.txt')).toThrow(/outside/)
    expect(() => resolveRunLog(wt, '.spec-review/runs/../../secret.txt')).toThrow(/outside/)
    expect(() => resolveRunLog(wt, '/etc/passwd')).toThrow(/outside/)
    expect(() => resolveRunLog(wt, '.spec-review/runs-evil/r.ndjson')).toThrow(/outside/)
  })
})

describe('apply helpers', () => {
  it('denies push, reset, rebase, rm and network tools regardless of the allowlist', () => {
    expect(DEFAULT_APPLY_DENY).toEqual(expect.arrayContaining([
      'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(rm:*)',
      'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'WebFetch', 'WebSearch',
    ]))
  })

  it('builds the prompt and reads outcomes', () => {
    expect(applyPrompt('c', [])).toContain('Implement the owner-approved OpenSpec change "c".')
    expect(applyPrompt('c', ['features/x.feature::A'])).toContain('- features/x.feature::A')
    // Final review Important 1(a): the Apply prompt carried no scenario keys at all unless it was
    // a reapply, so a needs_owner decision invented its own key.
    const withKeys = applyPrompt('c', [], [], ['features/x.feature::A title', 'features/x.feature::B title'])
    expect(withKeys).toContain('## Scenario keys')
    expect(withKeys).toContain('- features/x.feature::A title')
    expect(withKeys).toContain('- features/x.feature::B title')
    const result = (text: string, ok = true) => [{ type: 'result' as const, ok, text, numTurns: 3, sessionId: 's' }]
    expect(outcomeOf(result('done'), false).outcome).toBe('done')
    expect(outcomeOf(result('Stuck.\nNEEDS_OWNER: which weight?'), false).outcome).toBe('needs_owner')
    expect(outcomeOf(result('x', false), false).outcome).toBe('failed')
    expect(outcomeOf([], false).outcome).toBe('failed')
    expect(outcomeOf(result('done'), true).outcome).toBe('stopped')
    expect(readEvents('garbage\n{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"x","session_id":"s"}\n')).toHaveLength(1)
  })
})

describe('ApplyService', () => {
  it('refuses to start before approval is recorded or while not ready', async () => {
    const unrecorded = await setup({ record: false })
    await expect(unrecorded.apply.start(unrecorded.wt, unrecorded.ref)).rejects.toMatchObject({ code: 'approval_not_recorded' })
    const unapproved = await setup({ approve: false })
    await expect(unapproved.apply.start(unapproved.wt, unapproved.ref)).rejects.toMatchObject({ code: 'not_ready' })
  })

  it('reserves the worktree synchronously so concurrent starts cannot race', async () => {
    const { wt, ref, apply } = await setup()
    const results = await Promise.allSettled([apply.start(wt, ref), apply.start(wt, ref)])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'apply_running' })
    await apply.settled(fulfilled[0]!.value.id)
  })

  it('releases the reservation when a start is refused, so a later attempt can start', async () => {
    const { wt, ref, apply } = await setup({ record: false })
    await expect(apply.start(wt, ref)).rejects.toMatchObject({ code: 'approval_not_recorded' })
    expect(apply.active(wt.path)).toBe(false)
    await updateReview(ref.dir, (d) => recordApproval(d, '2026-09-23T10:00:00.000Z', 'abc1234'))
    const run = await apply.start(wt, ref)
    expect(apply.active(wt.path)).toBe(true)
    await apply.settled(run.id)
  })

  it('does not signal a non-positive pid when stopping', async () => {
    const { repo, wt, ref } = await setup()
    const kill = vi.fn()
    let resolveExited: (code: number | null) => void = () => undefined
    const exited = new Promise<number | null>((resolve) => {
      resolveExited = resolve
    })
    const isolated = new ApplyService({
      config: testConfig(repo, { codexBin: FAKE_CODEX }),
      bus: new EventBus(),
      pollMs: 50,
      spawn: () => ({ pid: -1, exited }),
      kill,
    })
    const run = await isolated.start(wt, ref)
    await isolated.stop(wt, ref)
    expect(kill).not.toHaveBeenCalled()
    resolveExited(0)
    await isolated.settled(run.id)
    expect((await readReview(ref.dir)).apply_runs[0]!.outcome).toBe('stopped')
  })

  it('runs /opsx:apply detached with the write allowlist and records the outcome', async () => {
    const { wt, ref, apply, events } = await setup()
    const run = await apply.start(wt, ref)
    expect(apply.active(wt.path)).toBe(true)
    await expect(apply.start(wt, ref)).rejects.toMatchObject({ code: 'apply_running' })
    await apply.settled(run.id)
    expect(apply.active(wt.path)).toBe(false)
    expect((await readReview(ref.dir)).apply_runs[0]).toMatchObject({ id: run.id, outcome: 'done', ended_at: expect.any(String) })
    const [call] = await calls()
    // Final review Important 1(a): the Apply prompt now always lists the change's scenario keys,
    // so a scenario-scoped decision can copy one verbatim instead of inventing it.
    expect(call!.prompt).toBe([
      'Implement the owner-approved OpenSpec change "add-thread-state".',
      'Read openspec/changes/add-thread-state/proposal.md, specs/ and features/ before making changes.',
      'Follow the repository AGENTS.md and the OpenSpec apply skill under .agents/skills/ when present.',
      'Implement the approved scenarios, run the configured checks and commit the implementation.',
      '',
      '## Scenario keys',
      'Copy one of these verbatim into decisions[].scope.key — never invent one:',
      "- features/thread_state.feature::The founder's reply resolves a waiting thread",
      '- features/thread_state.feature::A waiting thread is weighted by its age',
    ].join('\n'))
    expect(call!.args).toEqual(expect.arrayContaining(['exec', '--json', '--output-schema', 'sandbox_mode="read-only"', 'features.shell_tool=false']))
    expect(call!.args.find((arg) => arg.startsWith('mcp_servers='))).toContain('git add')
    expect(call!.args.find((arg) => arg.startsWith('mcp_servers='))).toContain('deniedCommands')
    expect(events.some((e) => e.topic === `run:${run.id}` && (e.data as { type: string }).type === 'event')).toBe(true)
    expect(await readFile(path.join(wt.path, run.log), 'utf8')).toContain('"type":"turn.completed"')
  })

  it('opens an apply thread when the agent needs the owner, and resumes the same session on reply', async () => {
    process.env.FAKE_CODEX_STRUCTURED = 'off'
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CODEX_TEXT = 'Stopped before step 3.\nNEEDS_OWNER: Which weight applies to CC threads?'
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    let review = await readReview(ref.dir)
    expect(review.apply_runs[0]!.outcome).toBe('needs_owner')
    const thread = review.threads.find((t) => t.anchor === 'apply')!
    expect(thread).toMatchObject({ ref: run.id, status: 'answered' })
    await updateReview(ref.dir, (d) => appendMessage(d, thread.id, { role: 'owner', at: 'now', text: 'Weight zero.', note: null, patch: null }))
    process.env.FAKE_CODEX_TEXT = 'Done, all green.'
    await apply.resume(wt, ref, thread.id)
    await apply.settled(run.id)
    review = await readReview(ref.dir)
    expect(review.apply_runs).toHaveLength(1)
    expect(review.apply_runs[0]!.outcome).toBe('done')
    expect(review.threads.find((t) => t.id === thread.id)!.messages.map((m) => m.text)).toEqual([
      'Stopped before step 3.\nNEEDS_OWNER: Which weight applies to CC threads?', 'Weight zero.', 'Done, all green.',
    ])
    const last = (await calls()).at(-1)!
    expect(last.args).toEqual(expect.arrayContaining(['resume', (await readReview(ref.dir)).apply_runs[0]!.session]))
    expect(last.prompt).toBe('Weight zero.')
  })

  it("does not resurface the previous attempt's result when a resumed run is stopped before producing its own", async () => {
    process.env.FAKE_CODEX_STRUCTURED = 'off'
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CODEX_TEXT = 'Stopped before step 3.\nNEEDS_OWNER: Which weight applies to CC threads?'
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    let review = await readReview(ref.dir)
    const thread = review.threads.find((t) => t.anchor === 'apply')!
    await updateReview(ref.dir, (d) => appendMessage(d, thread.id, { role: 'owner', at: 'now', text: 'Weight zero.', note: null, patch: null }))
    process.env.FAKE_CODEX_MODE = 'hang'
    await apply.resume(wt, ref, thread.id)
    await new Promise((r) => setTimeout(r, 300))
    await apply.stop(wt, ref)
    await apply.settled(run.id)
    review = await readReview(ref.dir)
    expect(review.apply_runs[0]!.outcome).toBe('stopped')
    const lastMessage = review.threads.find((t) => t.id === thread.id)!.messages.at(-1)!
    expect(lastMessage.text).toBe('Stopped by the owner.')
    expect(lastMessage.text).not.toContain('NEEDS_OWNER')
  })

  it('stops a running apply', async () => {
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CODEX_MODE = 'hang'
    const run = await apply.start(wt, ref)
    await new Promise((r) => setTimeout(r, 300))
    await apply.stop(wt, ref)
    await apply.settled(run.id)
    expect((await readReview(ref.dir)).apply_runs[0]!.outcome).toBe('stopped')
  })

  it('gives every apply run a unique id even when two runs start in the same second', async () => {
    const { repo, wt, ref } = await setup()
    const fixedNow = () => new Date('2026-09-23T10:00:00.000Z')
    const apply = new ApplyService({ config: testConfig(repo, { codexBin: FAKE_CODEX }), bus: new EventBus(), pollMs: 50, now: fixedNow })
    const run1 = await apply.start(wt, ref)
    await apply.settled(run1.id)
    const run2 = await apply.start(wt, ref)
    await apply.settled(run2.id)
    expect(run1.id).not.toBe(run2.id)
  })

  it('finalizes a run whose process died while the server was down', async () => {
    const { wt, ref, apply } = await setup()
    const log = '.spec-review/runs/r_dead.ndjson'
    await mkdir(path.join(wt.path, '.spec-review/runs'), { recursive: true })
    await writeFile(path.join(wt.path, log), '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"Finished.","session_id":"s"}\n')
    await updateReview(ref.dir, (d) =>
      upsertApplyRun(d, { id: 'r_dead', session: 's', pid: 999_999_999, log, started_at: 'then', ended_at: null, outcome: 'running', resume_offset: 0 }))
    await apply.reattach(wt, ref)
    expect((await readReview(ref.dir)).apply_runs[0]).toMatchObject({ id: 'r_dead', outcome: 'done' })
  })

  it('reattaches a dead RESUMED run from its own resume_offset, not the whole log', async () => {
    const { wt, ref, apply } = await setup()
    const log = '.spec-review/runs/r_resumed.ndjson'
    await mkdir(path.join(wt.path, '.spec-review/runs'), { recursive: true })
    const firstAttempt = '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Stopped.\\nNEEDS_OWNER: which weight?","session_id":"s"}\n'
    await writeFile(path.join(wt.path, log), firstAttempt)
    const offset = Buffer.byteLength(firstAttempt)
    // The resumed attempt wrote only a delta, then the server (and the child) died — no new
    // result event of its own.
    await appendFile(
      path.join(wt.path, log),
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Weight zero, resuming"}}}\n',
    )
    await updateReview(ref.dir, (d) =>
      upsertApplyRun(d, { id: 'r_resumed', session: 's', pid: 999_999_999, log, started_at: 'then', ended_at: null, outcome: 'running', resume_offset: offset }))
    await apply.reattach(wt, ref)
    const run = (await readReview(ref.dir)).apply_runs[0]!
    expect(run.outcome).toBe('failed')
  })

  it("marks a run whose log escapes .spec-review/runs/ as failed without aborting a sibling run's reattach", async () => {
    const { wt, ref, apply } = await setup()
    const goodLog = '.spec-review/runs/r_good.ndjson'
    await mkdir(path.join(wt.path, '.spec-review/runs'), { recursive: true })
    await writeFile(path.join(wt.path, goodLog), '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"Finished.","session_id":"s"}\n')
    await updateReview(ref.dir, (d) => {
      const withBad = upsertApplyRun(d, {
        id: 'r_bad', session: 's', pid: null, log: '../escape.ndjson', started_at: 'then', ended_at: null, outcome: 'running', resume_offset: 0,
      })
      return upsertApplyRun(withBad, { id: 'r_good', session: 's', pid: null, log: goodLog, started_at: 'then', ended_at: null, outcome: 'running', resume_offset: 0 })
    })
    await apply.reattach(wt, ref)
    const runs = (await readReview(ref.dir)).apply_runs
    expect(runs.find((r) => r.id === 'r_bad')).toMatchObject({ outcome: 'failed' })
    expect(runs.find((r) => r.id === 'r_good')).toMatchObject({ outcome: 'done' })
  })
})
