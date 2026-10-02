import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBaseApp } from '../app.ts'
import { addDecisions, findDecision, ownerDecision } from '../decision-model.ts'
import { worktreeId } from '../discovery.ts'
import { git, headSha } from '../git.ts'
import { QuestionService } from '../questions.ts'
import { readReview, updateReview } from '../review-store.ts'
import { FAKE_CODEX, resetFakeCodex } from '../testing/fake-codex-path.ts'
import { call, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerDecisionRoutes } from './decisions.ts'
import { registerReadRoutes } from './read.ts'
import { registerThreadRoutes } from './threads.ts'

const REL = 'openspec/changes/add-thread-state'
const FEATURE = `${REL}/features/thread_state.feature`
const OUTLINE = 'features/thread_state.feature::A waiting thread is weighted by its age'
const OPTIONS = [
  { id: 'business', label: 'Business hours', consequence: 'Weekends do not age a thread.' },
  { id: 'calendar', label: 'Calendar hours', consequence: 'Weekends age a thread.' },
]
const reply = (over: Record<string, unknown> = {}) => ({ answer: 'Ok.', patch: null, decisions: [], resolves: [], status: 'answered', ...over })
let fakeLog = ''

async function decisionDiff(repo: string): Promise<string> {
  const file = path.join(repo, FEATURE)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace('  Scenario Outline:', '  # Owner decision 2026-09-24: rows weigh by business-hour age.\n  Scenario Outline:'))
  const diff = await git(repo, ['diff', '--', FEATURE])
  await writeFile(file, original)
  return diff
}

async function setup() {
  const { repo } = await makeRepo()
  const ctx = testContext(repo, { codexBin: FAKE_CODEX })
  const questions = new QuestionService({ config: ctx.config, bus: ctx.bus })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { codex: true, docker: false })
  registerThreadRoutes(app, ctx, { questions, applyActive: () => false, resumeApply: null })
  registerDecisionRoutes(app, ctx, { questions })
  await call(app, 'GET', '/api/changes')
  return { repo, app, questions, dir: path.join(repo, REL), change: `/api/changes/${worktreeId(repo)}/add-thread-state` }
}

type Setup = Awaited<ReturnType<typeof setup>>

// The agent raises a blocking scenario decision; the owner decides it; the agent answers with a
// patch that resolves it.
async function raiseAndDecide({ repo, app, questions, dir, change }: Setup) {
  process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({
    answer: 'Your call.',
    decisions: [{ id: 'age_basis', question: 'Business or calendar age?', scope: { kind: 'scenario', key: OUTLINE }, options: OPTIONS, recommended: 'business', blocking: true }],
  }))
  const thread = await call(app, 'POST', `${change}/threads`, { anchor: 'scenario', ref: OUTLINE, text: 'Which age?' })
  await questions.idle(dir)
  const decisionId = (await readReview(dir)).decisions[0]!.id
  process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({ answer: 'Recorded above the outline.', patch: await decisionDiff(repo), resolves: [decisionId] }))
  const decided = await call(app, 'POST', `${change}/decisions/${decisionId}/decide`, { option: 'business', note: 'Weekdays only.' })
  await questions.idle(dir)
  return { threadId: thread.json.id as string, decisionId, decided }
}

const calls = async () => (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string })

beforeEach(async () => {
  resetFakeCodex()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-decisions-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CODEX_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CODEX_LOG = fakeLog
  process.env.FAKE_CODEX_MODE = 'answer'
})

describe('decision routes', () => {
  it('rejects a bad choice before anything changes', async () => {
    const s = await setup()
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply({
      decisions: [{ id: 'age_basis', question: 'Business or calendar age?', scope: { kind: 'scenario', key: OUTLINE }, options: OPTIONS, recommended: 'business', blocking: true }],
    }))
    await call(s.app, 'POST', `${s.change}/threads`, { anchor: 'scenario', ref: OUTLINE, text: 'Which age?' })
    await s.questions.idle(s.dir)
    const id = (await readReview(s.dir)).decisions[0]!.id
    const view = await call(s.app, 'GET', s.change)
    expect(view.json.decisions[0]).toMatchObject({ id, orphaned: false, status: 'open' })
    expect(view.json.readiness.reasons).toContain('1 blocking decision open')
    expect((await call(s.app, 'POST', `${s.change}/decisions/${id}/decide`, {})).json.error.code).toBe('option_required')
    const unknown = await call(s.app, 'POST', `${s.change}/decisions/${id}/decide`, { option: 'hourly' })
    expect(unknown.status).toBe(422)
    expect(unknown.json.error.code).toBe('unknown_option')
    expect(findDecision(await readReview(s.dir), id).status).toBe('open')
  })

  it('passes the recorded owner choice into the resumed Codex prompt', async () => {
    const s = await setup()
    const { threadId, decisionId, decided } = await raiseAndDecide(s)
    expect((await calls()).at(-1)!.prompt).toContain(`Owner decided ${decisionId}`)
  })

  it('leaves the resolved decision decided when the patch commit fails', async () => {
    const s = await setup()
    const { threadId, decisionId } = await raiseAndDecide(s)
    await writeFile(path.join(s.repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const res = await call(s.app, 'POST', `${s.change}/threads/${threadId}/patches/3/apply`, { summary: 'x' })
    expect(res.json.error.code).toBe('command_failed')
    const review = await readReview(s.dir)
    expect(findDecision(review, decisionId)).toMatchObject({ status: 'decided', recorded: null })
    expect(review.threads[0]!.messages[3]!.patch!.state).toBe('proposed')
  })

  it('records an owner decision on the whole change in decisions.md with review.yaml', async () => {
    const { repo, app, dir, change } = await setup()
    const created = await call(app, 'POST', `${change}/decisions`, { question: 'Ship behind a flag?', scope: { kind: 'change' }, blocking: true })
    expect(created.status).toBe(201)
    const id = created.json.id as string
    expect((await call(app, 'POST', `${change}/decisions/${id}/decide`, { note: ' ' })).json.error.code).toBe('note_required')
    const decided = await call(app, 'POST', `${change}/decisions/${id}/decide`, { note: 'Yes, behind a flag.' })
    expect(decided.json).toEqual({ status: 'recorded', commit: await headSha(repo) })
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): add-thread-state — Ship behind a flag? (owner decision)')
    expect(await readFile(path.join(dir, 'decisions.md'), 'utf8')).toContain('Note: Yes, behind a flag.')
    const view = await call(app, 'GET', change)
    expect(view.json.decisionLog[0]).toMatchObject({ question: 'Ship behind a flag?', id })
    expect(view.json.decisions[0]).toMatchObject({ status: 'recorded', recorded: { how: 'decisions_md', commit: decided.json.commit } })
  })

  it('validates new decisions', async () => {
    const { app, change } = await setup()
    const scenario = { question: 'Q?', scope: { kind: 'scenario', key: 'features/x.feature::Nope' }, blocking: false }
    expect((await call(app, 'POST', `${change}/decisions`, scenario)).json.error.code).toBe('unknown_scenario')
    const oneOption = { question: 'Q?', scope: { kind: 'change' }, blocking: false, options: [OPTIONS[0]] }
    expect((await call(app, 'POST', `${change}/decisions`, oneOption)).json.error.code).toBe('invalid_body')
    expect((await call(app, 'POST', `${change}/decisions`, { question: ' ', scope: { kind: 'change' }, blocking: false })).status).toBe(400)
  })


  it('dismisses with a reason, once', async () => {
    const { app, dir, change } = await setup()
    const { json } = await call(app, 'POST', `${change}/decisions`, { question: 'Q?', scope: { kind: 'change' }, blocking: true })
    expect((await call(app, 'POST', `${change}/decisions/${json.id}/dismiss`, { reason: ' ' })).json.error.code).toBe('invalid_body')
    expect((await call(app, 'POST', `${change}/decisions/${json.id}/dismiss`, { reason: 'Out of scope.' })).status).toBe(200)
    expect(findDecision(await readReview(dir), json.id)).toMatchObject({ status: 'dismissed', dismissed: { reason: 'Out of scope.' } })
    expect((await call(app, 'POST', `${change}/decisions/${json.id}/dismiss`, { reason: 'Again.' })).json.error.code).toBe('decision_closed')
    expect((await call(app, 'POST', `${change}/decisions/d_nope/dismiss`, { reason: 'x' })).json.error.code).toBe('unknown_decision')
  })

  it('refuses to decide an orphaned decision until it is re-attached', async () => {
    const { app, dir, change } = await setup()
    const orphan = ownerDecision(
      { question: 'Gone?', scope: { kind: 'scenario', key: 'features/gone.feature::Gone' }, blocking: true, options: OPTIONS },
      '2026-09-24T10:00:00.000Z',
      () => 'd_0000dead',
    )
    await updateReview(dir, (d) => addDecisions(d, [orphan]))
    expect((await call(app, 'GET', change)).json.decisions[0].orphaned).toBe(true)
    expect((await call(app, 'POST', `${change}/decisions/d_0000dead/decide`, { option: 'business' })).json.error.code).toBe('decision_orphaned')
    expect((await call(app, 'POST', `${change}/decisions/d_0000dead/reattach`, { to: 'features/x.feature::Nope' })).json.error.code).toBe('unknown_scenario')
    expect((await call(app, 'POST', `${change}/decisions/d_0000dead/reattach`, { to: OUTLINE })).status).toBe(200)
    expect((await call(app, 'GET', change)).json.decisions[0]).toMatchObject({ orphaned: false, scope: { kind: 'scenario', key: OUTLINE } })
  })
})
