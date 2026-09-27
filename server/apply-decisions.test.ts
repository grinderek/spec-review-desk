import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApplyService } from './apply.ts'
import { discover, listChanges, Registry } from './discovery.ts'
import { type BusEvent, EventBus } from './events.ts'
import { readReview, recordApproval, updateReview } from './review-store.ts'
import { FAKE_CLAUDE, resetFakeClaude } from './testing/fake-claude-path.ts'
import { testConfig } from './testing/http.ts'
import { makeRepo } from './testing/repo.ts'
import { approveEverything } from './testing/review.ts'

const OUTLINE = 'features/thread_state.feature::A waiting thread is weighted by its age'
const reply = (over: Record<string, unknown> = {}) => ({ answer: 'All green.', patch: null, decisions: [], resolves: [], status: 'done', ...over })
const blocking = {
  id: 'cc_weight',
  question: 'Which weight for CC threads?',
  scope: { kind: 'scenario', key: OUTLINE },
  options: [{ id: 'zero', label: 'Zero', consequence: 'CC threads never count.' }, { id: 'half', label: 'Half', consequence: 'CC threads count half.' }],
  recommended: 'zero',
  blocking: true,
}
let fakeLog = ''

async function setup() {
  const { repo } = await makeRepo()
  const registry = new Registry()
  await discover([{ name: 'api', path: repo }], registry)
  const wt = registry.all()[0]!
  const ref = (await listChanges(wt)).find((c) => c.name === 'add-thread-state')!
  await approveEverything(wt, ref)
  await updateReview(ref.dir, (d) => recordApproval(d, '2026-09-24T10:00:00.000Z', 'abc1234'))
  const bus = new EventBus()
  const events: BusEvent[] = []
  bus.subscribe('*', (e) => events.push(e))
  const apply = new ApplyService({ config: testConfig(repo, { claudeBin: FAKE_CLAUDE }), bus, pollMs: 50 })
  return { wt, ref, apply, events }
}

const calls = async () => (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string })

beforeEach(async () => {
  resetFakeClaude()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-apply-decisions-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CLAUDE_LOG = fakeLog
  process.env.FAKE_CLAUDE_MODE = 'answer'
})

describe('structured Apply outcomes', () => {
  it('turns needs_owner into decisions of the run and an apply thread, and streams the answer', async () => {
    const { wt, ref, apply, events } = await setup()
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply({ answer: 'Stopped before step 3.', status: 'needs_owner', decisions: [blocking] }))
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    const review = await readReview(ref.dir)
    expect(review.apply_runs[0]!.outcome).toBe('needs_owner')
    expect(review.decisions[0]).toMatchObject({ agent_id: 'cc_weight', source: { kind: 'apply', run: run.id }, status: 'open', blocking: true })
    const thread = review.threads.find((t) => t.anchor === 'apply')!
    expect(thread.messages[0]).toMatchObject({ text: 'Stopped before step 3.', decision_ids: [review.decisions[0]!.id], note: `apply run ${run.id}: needs_owner` })
    const answer = events
      .filter((e) => e.topic === `run:${run.id}`)
      .flatMap((e) => {
        const data = e.data as { type: string; event?: { type: string; text?: string } }
        return data.type === 'event' && data.event?.type === 'answer_delta' ? [data.event.text ?? ''] : []
      })
      .join('')
    expect(answer).toBe('Stopped before step 3.')
    expect((await calls())[0]!.args).toContain('--json-schema')
  })

  it('retries an invalid reply once in the same session, and settled() waits for the retry', async () => {
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CLAUDE_STRUCTURED = 'invalid-then-valid'
    process.env.FAKE_CLAUDE_REPLY = JSON.stringify(reply())
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    const all = await calls()
    expect(all).toHaveLength(2)
    expect(all[1]!.prompt).toMatch(/^Your reply did not pass validation: /)
    expect(all[1]!.args).toEqual(expect.arrayContaining(['--resume', run.session]))
    const review = await readReview(ref.dir)
    expect(review.apply_runs[0]).toMatchObject({ outcome: 'done', validation_retry: true })
    expect(review.threads.filter((t) => t.anchor === 'apply')).toEqual([])
    expect(apply.active(wt.path)).toBe(false)
  })

  it('stops after the second invalid reply: failed, an apply thread with the issues, no decisions', async () => {
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CLAUDE_STRUCTURED = 'invalid-twice'
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    expect(await calls()).toHaveLength(2)
    const review = await readReview(ref.dir)
    expect(review.apply_runs[0]!.outcome).toBe('failed')
    expect(review.decisions).toEqual([])
    const message = review.threads.find((t) => t.anchor === 'apply')!.messages[0]!
    expect(message.invalid?.issues.some((i) => i.includes('recommended'))).toBe(true)
    expect(message.invalid?.issues.some((i) => i.startsWith('status:'))).toBe(true)
  })

  it('keeps the NEEDS_OWNER prose fallback when the reply is not structured', async () => {
    const { wt, ref, apply } = await setup()
    process.env.FAKE_CLAUDE_STRUCTURED = 'off'
    process.env.FAKE_CLAUDE_TEXT = 'Stuck.\nNEEDS_OWNER: which weight?'
    const run = await apply.start(wt, ref)
    await apply.settled(run.id)
    const review = await readReview(ref.dir)
    expect(review.apply_runs[0]!.outcome).toBe('needs_owner')
    expect(review.decisions).toEqual([])
    expect(review.threads.find((t) => t.anchor === 'apply')!.messages[0]!.invalid).toBeUndefined()
    expect(await calls()).toHaveLength(1)
  })
})
