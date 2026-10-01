import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CodexRunSpec } from './codex.ts'
import { EventBus } from './events.ts'
import { readInitiative } from './initiative-store.ts'
import { startPlanner } from './planner-run.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService } from './run-service.ts'
import type { RunOptions, SandboxOutcome, SandboxRun } from './sandbox.ts'
import { ROTATE_HINT } from './secret-scan.ts'
import { resetFakeCodex } from './testing/fake-codex-path.ts'
import { FAKE_TOKEN, FakeSandbox } from './testing/fake-sandbox.ts'
import { testConfig } from './testing/http.ts'
import { makeInitiative } from './testing/initiative.ts'
import { makeRepo } from './testing/repo.ts'

const claude: CodexRunSpec = {
  bin: 'claude', cwd: '/work/in', sessionId: 's-1', resume: false, model: 'gpt-5.4', allowedTools: ['Read'],
  disallowedTools: ['Bash'], permissionMode: 'default', appendSystemPrompt: null, prompt: 'Plan the slices.', jsonSchema: null,
}

beforeEach(() => {
  resetFakeCodex()
  delete process.env.FAKE_CODEX_LOG
  process.env.FAKE_CODEX_MODE = 'answer'
})

// Review Minor #4: a stop() issued when no attempt of a run id is in flight (between a validation
// retry and its relaunch, or between a "needs_owner" run and its Resume) must not leak into a LATER
// attempt of the same run id and make a normal completion look like it was stopped.
describe('FakeSandbox.run', () => {
  it('clears a stale stop mark from an earlier out-of-band stop before a new attempt begins', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-fake-sandbox-'))
    const sandbox = new FakeSandbox()
    await sandbox.stop('r_stale') // no attempt in flight yet — the mark must not linger
    const outcome = await sandbox.run(
      { runId: 'r_stale', runDir: tmp, room: tmp, out: tmp, sessions: tmp, domains: [], codex: claude },
      { timeoutMs: 10_000, onLine: () => undefined },
    )
    expect(outcome).toMatchObject({ stopped: false, code: 0 })
  })
})

// Review round 4 (leak3/leak4 reproductions): the token, or any >= 8-char piece of it, must never
// reach an irun: bus event, the run log file, log(), initiative.yaml or review.yaml — neither in
// one entry nor in the concatenation of all entries — and a run that saw it must end failed.
const T = FAKE_TOKEN
const HALF = Math.floor(T.length / 2)
const PIECES = Array.from({ length: T.length - 7 }, (_, i) => T.slice(i, i + 8))
const leaks = (text: string): string | undefined => PIECES.find((piece) => text.includes(piece))

const line = (event: unknown): string => JSON.stringify({ type: 'stream_event', event, session_id: 's' })
const frag = (text: string): string[] => text.match(/.{1,6}/g) ?? []
const narrate = (text: string) => frag(text).map((c) => line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }))
const think = (text: string) => frag(text).map((c) => line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: c } }))
const answerJson = (obj: unknown) => [
  line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'StructuredOutput', id: 't' } }),
  ...frag(JSON.stringify(obj)).map((c) => line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: c } })),
]
const reply = (over: Record<string, unknown> = {}) => ({
  answer: 'Two slices.', patch: null, decisions: [], resolves: [], status: 'done', slices: [{ title: 'Engine', scope: 'The pure engine.', depends_on: [] }], ...over,
})
const result = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: 's', ...over })
interface Attempt { lines: string[]; out?: Partial<SandboxOutcome> }

async function scenario(attempts: Attempt[]) {
  let index = 0
  class Scripted extends FakeSandbox {
    override run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
      this.runs.push(spec)
      const attempt = attempts[Math.min(index++, attempts.length - 1)]!
      for (const l of attempt.lines) opts.onLine(l)
      return Promise.resolve({ code: 0, timedOut: false, stopped: false, error: null, ...attempt.out })
    }
  }
  const { repo } = await makeRepo()
  const { wt, ini, dir } = await makeInitiative(repo)
  const bus = new EventBus()
  const events: { topic: string; data: unknown }[] = []
  bus.subscribe('*', (e) => events.push(e))
  const service = new InitiativeRunService({ config: testConfig(repo), bus, sandbox: new Scripted(), finishers: FINISHERS })
  const run = await startPlanner(service, { wt, ini })
  await service.settled(run.id)
  const doc = await readInitiative(dir)
  const logFile = await readFile(path.join(repo, run.log), 'utf8').catch(() => '')
  const entries = logFile.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const busEvents = events.filter((e) => e.topic === `irun:${run.id}`).map((e) => e.data as { event?: Record<string, unknown> })
  const joined = (values: (Record<string, unknown> | undefined)[]) => values.map((v) => Object.values(v ?? {}).filter((x) => typeof x === 'string').join('')).join('')
  const served = (await service.log({ wt, ini }, run.id)).text
  const review = await readFile(path.join(dir, 'review.yaml'), 'utf8').catch(() => '')
  const surfaces = {
    logFile, logJoined: joined(entries), served, bus: JSON.stringify(busEvents), busJoined: joined(busEvents.map((e) => e.event)),
    initiative: JSON.stringify(doc), initiativeFile: await readFile(path.join(dir, 'initiative.yaml'), 'utf8'), review,
  }
  return { run: doc.runs[0]!, doc, served, attempts: index, leaked: Object.entries(surfaces).flatMap(([k, v]) => (leaks(v) ? [`${k}: ${leaks(v)}`] : [])) }
}

const SECRET_FAIL = { outcome: 'failed', notes: ROTATE_HINT, problems: ['a secret appeared in the agent output'] }

describe('run secrets (review round 4)', () => {
  it('masks a tool name that is the token on disk and on the bus, and fails the run', async () => {
    const r = await scenario([{ lines: [line({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: T, id: 'x' } }), result({ structured_output: reply() })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('masks a session id that is the token (init and result) and fails the run', async () => {
    const r = await scenario([{ lines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: T }), result({ session_id: T, structured_output: reply() })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('masks a token cut off mid-stream by a stop and records a secret problem', async () => {
    const r = await scenario([{ lines: narrate(`hello ${T.slice(0, 25)}`), out: { stopped: true, code: 137 } }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('masks a token cut off mid-stream by a timeout (thinking + answer) and records a secret problem', async () => {
    const lines = [...think(T.slice(0, 25)), ...answerJson({ answer: `x ${T.slice(0, 25)}` }).slice(0, 12)]
    const r = await scenario([{ lines, out: { timedOut: true, code: 137 } }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('fails a token split narration -> thinking', async () => {
    const r = await scenario([{ lines: [...narrate(`a ${T.slice(0, HALF)}`), ...think(T.slice(HALF)), result({ structured_output: reply() })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('fails a token split narration -> answer', async () => {
    const answered = reply({ answer: `${T.slice(HALF)} tail` })
    const r = await scenario([{ lines: [...narrate(`see ${T.slice(0, HALF)}`), ...answerJson(answered), result({ structured_output: answered })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('fails a token split across the two attempts of a validation retry', async () => {
    const r = await scenario([
      { lines: [...narrate(`see ${T.slice(0, HALF)}`), result({ structured_output: { answer: 'bad' } })] },
      { lines: [...narrate(`${T.slice(HALF)} done`), result({ structured_output: reply() })] },
    ])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('fails a token interleaved across channels in pieces shorter than 8 characters (the run-wide detector)', async () => {
    const lines = frag(T).map((c, i) => (i % 2 ? think(c)[0]! : narrate(c)[0]!))
    const r = await scenario([{ lines: [...lines, result({ structured_output: reply() })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.served).not.toContain(T)
  })

  it('fails a token whose halves sit in two reply fields and never writes either to initiative.yaml or review.yaml', async () => {
    const split = reply({ answer: `a ${T.slice(0, HALF)}`, slices: [{ title: T.slice(HALF), scope: 's', depends_on: [] }] })
    const r = await scenario([{ lines: [result({ structured_output: split })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.doc.plan.status).toBe('none')
    expect(r.leaked).toEqual([])
  })

  it('fails a failed result whose text carries a token prefix, masking it', async () => {
    const r = await scenario([{ lines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: `err ${T.slice(0, 25)}`, session_id: 's' })] }])
    expect(r.run).toMatchObject(SECRET_FAIL)
    expect(r.leaked).toEqual([])
  })

  it('serves only the latest answer after a validation retry', async () => {
    const r = await scenario([
      { lines: [...answerJson(reply({ answer: 'Stale answer.', slices: [] })), result({ structured_output: reply({ answer: 'Stale answer.', slices: [] }) })] },
      { lines: [...answerJson(reply({ answer: 'Fresh answer.' })), result({ structured_output: reply({ answer: 'Fresh answer.' }) })] },
    ])
    expect(r.attempts).toBe(2)
    expect(r.run.outcome).toBe('done')
    expect(r.served).toBe('Fresh answer.')
  })

  it('serves only the answer after an answer_reset within one attempt', async () => {
    const final = reply({ answer: 'Second draft.' })
    const r = await scenario([{ lines: [...answerJson({ answer: 'First draft.' }), ...answerJson(final), result({ structured_output: final })] }])
    expect(r.run.outcome).toBe('done')
    expect(r.served).toBe('Second draft.')
  })
})
