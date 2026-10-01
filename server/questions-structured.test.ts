import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { discover, listChanges, Registry } from './discovery.ts'
import { type BusEvent, EventBus } from './events.ts'
import { ownerMessage, QuestionService } from './questions.ts'
import { addThread, readReview, updateReview } from './review-store.ts'
import { FAKE_CODEX, resetFakeCodex } from './testing/fake-codex-path.ts'
import { testConfig } from './testing/http.ts'
import { makeRepo } from './testing/repo.ts'

const OUTLINE = 'features/thread_state.feature::A waiting thread is weighted by its age'
const reply = (over: Record<string, unknown> = {}) => ({ answer: 'Two readings.', patch: null, decisions: [], resolves: [], status: 'answered', ...over })
const decision = {
  id: 'age_basis',
  question: 'Business or calendar age?',
  scope: { kind: 'scenario', key: OUTLINE },
  options: [
    { id: 'business', label: 'Business hours', consequence: 'Weekends do not age a thread.' },
    { id: 'calendar', label: 'Calendar hours', consequence: 'Weekends age a thread.' },
  ],
  recommended: 'business',
  blocking: true,
}
let fakeLog = ''

async function setup() {
  const { repo } = await makeRepo()
  const registry = new Registry()
  await discover([{ name: 'api', path: repo }], registry)
  const wt = registry.all()[0]!
  const ref = (await listChanges(wt)).find((c) => c.name === 'add-thread-state')!
  const bus = new EventBus()
  const events: BusEvent[] = []
  bus.subscribe('*', (e) => events.push(e))
  const questions = new QuestionService({ config: testConfig(repo, { codexBin: FAKE_CODEX }), bus })
  await updateReview(ref.dir, (d) => addThread(d, { id: 't_1', anchor: 'scenario', ref: OUTLINE, status: 'open', messages: [ownerMessage('Which age?')] }))
  return { wt, ref, questions, events }
}

const calls = async () =>
  (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string })
const threadEvents = (events: BusEvent[], type: string) =>
  events.filter((e) => e.topic === 'thread:t_1' && (e.data as { type: string }).type === type)
const deltas = (events: BusEvent[]): string => threadEvents(events, 'delta').map((e) => (e.data as { text: string }).text).join('')

beforeEach(async () => {
  resetFakeCodex()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-structured-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CODEX_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CODEX_LOG = fakeLog
  process.env.FAKE_CODEX_MODE = 'answer'
})

describe('structured question replies', () => {
  it('stores the answer, creates its decisions and streams only the answer text', async () => {
    const { wt, ref, questions, events } = await setup()
    const answer = 'Two readings: "business" or calendar — ü 😀.'
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({ answer, decisions: [decision] }))
    await questions.ask(wt, ref, 't_1')
    const review = await readReview(ref.dir)
    const thread = review.threads[0]!
    expect(thread.status).toBe('answered')
    expect(review.decisions).toHaveLength(1)
    expect(review.decisions[0]).toMatchObject({
      agent_id: 'age_basis', source: { kind: 'thread', id: 't_1' }, status: 'open', blocking: true, recommended: 'business',
      scope: { kind: 'scenario', key: OUTLINE },
    })
    expect(review.decisions[0]!.id).toMatch(/^d_[0-9a-f]{8}$/)
    expect(thread.messages[1]).toMatchObject({ role: 'agent', text: answer, patch: null, decision_ids: [review.decisions[0]!.id] })
    expect(thread.messages[1]!.invalid).toBeUndefined()
    expect(deltas(events)).toBe(answer)
    const [call] = await calls()
    expect(call!.args).toContain('--output-schema')
    expect(call!.prompt).toContain('## Decisions')
    expect(call!.prompt).toContain('openspec/changes/add-thread-state/decisions.md')
  })

  // Final review Important 1: the prompt now lists every scenario key so an agent can copy one
  // verbatim into `scope.key` instead of inventing it (the ledger's real-CLI failure, Task 14).
  it('lists the scenario keys verbatim, and a reply that copies one from the list validates', async () => {
    const { wt, ref, questions } = await setup()
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({ decisions: [decision] }))
    await questions.ask(wt, ref, 't_1')
    const [call] = await calls()
    expect(call!.prompt).toContain('## Scenario keys')
    expect(call!.prompt).toContain(`- ${OUTLINE}`)
    const review = await readReview(ref.dir)
    expect(review.decisions[0]).toMatchObject({ scope: { kind: 'scenario', key: OUTLINE } })
    expect(review.threads[0]!.messages[1]!.invalid).toBeUndefined()
  })

  it('retries once in the same session with the issues and keeps the valid second reply', async () => {
    const { wt, ref, questions, events } = await setup()
    process.env.FAKE_CODEX_STRUCTURED = 'invalid-then-valid'
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({ answer: 'Fixed.' }))
    await questions.ask(wt, ref, 't_1')
    const [first, second] = await calls()
    expect(second!.prompt).toMatch(/^Your reply did not pass validation: decisions\[0\]\.recommended: "sqlite" is not one of the option ids/)
    const session = (await readReview(ref.dir)).agent_session!
    expect(second!.args).toEqual(expect.arrayContaining(['resume', session]))
    const review = await readReview(ref.dir)
    expect(review.threads[0]!.status).toBe('answered')
    expect(review.threads[0]!.messages[1]).toMatchObject({ text: 'Fixed.' })
    expect(review.decisions).toEqual([])
    expect(threadEvents(events, 'reset')).not.toHaveLength(0)
    expect(deltas(events)).toContain('Fixed.')
  })

  it('stores an invalid message after the second failure, leaves the thread open and creates no decision', async () => {
    const { wt, ref, questions } = await setup()
    process.env.FAKE_CODEX_STRUCTURED = 'invalid-twice'
    await questions.ask(wt, ref, 't_1')
    expect(await calls()).toHaveLength(2)
    const review = await readReview(ref.dir)
    const message = review.threads[0]!.messages[1]!
    expect(review.threads[0]!.status).toBe('open')
    expect(message.invalid?.issues[0]).toMatch(/recommended: "sqlite"/)
    expect(message.invalid?.raw).toContain('"sqlite"')
    expect(message.decision_ids).toBeUndefined()
    expect(review.decisions).toEqual([])
  })

  it('treats a schema violation like a semantic one', async () => {
    const { wt, ref, questions } = await setup()
    process.env.FAKE_CODEX_REPLY = JSON.stringify({ answer: 42 })
    await questions.ask(wt, ref, 't_1')
    expect(await calls()).toHaveLength(2)
    const message = (await readReview(ref.dir)).threads[0]!.messages[1]!
    expect(message.invalid?.issues.some((i) => i.startsWith('answer:'))).toBe(true)
  })
})
