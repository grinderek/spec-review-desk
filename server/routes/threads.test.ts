import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBaseApp } from '../app.ts'
import { loadChangeView } from '../change-view.ts'
import { listChanges, Registry, worktreeId } from '../discovery.ts'
import { git, headSha } from '../git.ts'
import { QuestionService } from '../questions.ts'
import { readReview, setAgentSession, setEntry, updateReview } from '../review-store.ts'
import { FAKE_CLAUDE } from '../testing/fake-claude-path.ts'
import { call, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerReadRoutes } from './read.ts'
import { registerThreadRoutes } from './threads.ts'

const REL = 'openspec/changes/add-thread-state'
const FEATURE = `${REL}/features/thread_state.feature`
const OUTLINE = 'features/thread_state.feature::A waiting thread is weighted by its age'
let fakeLog = ''

async function decisionDiff(repo: string, target = FEATURE): Promise<string> {
  const file = path.join(repo, FEATURE)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace('  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n  Scenario Outline:'))
  const diff = await git(repo, ['diff', '--', FEATURE])
  await writeFile(file, original)
  return target === FEATURE ? diff : diff.replaceAll(FEATURE, target)
}

async function setup(opts: { applyActive?: boolean; timeoutMs?: number } = {}) {
  const { repo } = await makeRepo()
  const ctx = testContext(repo, { claudeBin: FAKE_CLAUDE, questionTimeoutMs: opts.timeoutMs ?? 10_000 })
  const questions = new QuestionService({ config: ctx.config, bus: ctx.bus })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { claude: true, docker: false })
  registerThreadRoutes(app, ctx, { questions, applyActive: () => opts.applyActive ?? false, resumeApply: null })
  const wt = worktreeId(repo)
  await call(app, 'GET', '/api/changes')
  const dir = path.join(repo, REL)
  const base = `/api/changes/${wt}/add-thread-state/threads`
  return { repo, ctx, app, questions, dir, base }
}

beforeEach(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-threads-'))
  fakeLog = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CLAUDE_LOG = fakeLog
  process.env.FAKE_CLAUDE_MODE = 'answer'
  delete process.env.FAKE_CLAUDE_TEXT_FILE
})

const calls = async () => (await readFile(fakeLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string })

describe('question threads', () => {
  it('asks the agent in a new session and stores its answer with a vetted patch', async () => {
    const { repo, app, questions, dir, base } = await setup()
    process.env.FAKE_CLAUDE_TEXT = `Rows weigh by business-hour age.\n\n\`\`\`diff\n${await decisionDiff(repo)}\`\`\`\n`
    const created = await call(app, 'POST', base, { anchor: 'scenario', ref: OUTLINE, text: 'Why business hours?' })
    expect(created.status).toBe(201)
    await questions.idle(dir)
    const review = await readReview(dir)
    const thread = review.threads[0]!
    expect(thread).toMatchObject({ id: created.json.id, status: 'answered', anchor: 'scenario', ref: OUTLINE })
    expect(thread.messages.map((m) => m.role)).toEqual(['owner', 'agent'])
    expect(thread.messages[1]!.patch).toMatchObject({ state: 'proposed', error: null })
    expect(review.agent_session).toMatch(/^[0-9a-f-]{36}$/)
    const [first] = await calls()
    expect(first!.args).toEqual(expect.arrayContaining(['--session-id', review.agent_session, '--allowedTools=Read,Grep,Glob', '--model', 'opus']))
    expect(first!.prompt).toContain('Scenario Outline: A waiting thread is weighted by its age')
    expect(first!.prompt).toContain('Why business hours?')
  })

  it('resumes the same session for the next question', async () => {
    const { app, questions, dir, base } = await setup()
    process.env.FAKE_CLAUDE_TEXT = 'First answer.'
    const { json } = await call(app, 'POST', base, { anchor: 'change', ref: '', text: 'Overview?' })
    await questions.idle(dir)
    process.env.FAKE_CLAUDE_TEXT = 'Second answer.'
    expect((await call(app, 'POST', `${base}/${json.id}/messages`, { text: 'And then?' })).status).toBe(202)
    await questions.idle(dir)
    const session = (await readReview(dir)).agent_session!
    expect((await calls())[1]!.args).toEqual(expect.arrayContaining(['--resume', session]))
    expect((await readReview(dir)).threads[0]!.messages.map((m) => m.text)).toEqual(['Overview?', 'First answer.', 'And then?', 'Second answer.'])
  })

  it('falls back to a fresh session when the stored one is gone', async () => {
    const { app, questions, dir, base } = await setup()
    await updateReview(dir, (d) => setAgentSession(d, '99999999-9999-4999-8999-999999999999'))
    process.env.FAKE_CLAUDE_TEXT = 'Rebuilt.'
    await call(app, 'POST', base, { anchor: 'change', ref: '', text: 'Hi?' })
    await questions.idle(dir)
    const review = await readReview(dir)
    expect(review.agent_session).not.toBe('99999999-9999-4999-8999-999999999999')
    expect(review.threads[0]!.messages[1]).toMatchObject({ text: 'Rebuilt.', note: 'new agent session — earlier context rebuilt from files' })
  })

  it('marks a patch outside the change stale and never applies it', async () => {
    const { repo, app, questions, dir, base } = await setup()
    process.env.FAKE_CLAUDE_TEXT = `Edit the model.\n\n\`\`\`diff\n${await decisionDiff(repo, 'app/models/thread.rb')}\`\`\`\n`
    const { json } = await call(app, 'POST', base, { anchor: 'change', ref: '', text: 'Fix it?' })
    await questions.idle(dir)
    const patch = (await readReview(dir)).threads[0]!.messages[1]!.patch!
    expect(patch).toMatchObject({ state: 'stale', error: expect.stringMatching(/outside/) })
    expect((await call(app, 'POST', `${base}/${json.id}/patches/1/apply`, { summary: 'x' })).json.error.code).toBe('patch_not_proposed')
  })

  it('applies a patch as an owner-decision commit and sends the approved scenario back to pending', async () => {
    const { repo, ctx, app, questions, dir, base } = await setup()
    const [wt] = ctx.registry.all()
    const view = await loadChangeView(wt!, (await listChanges(wt!))[0]!, { withCommits: false })
    const outline = view.features[0]!.scenarios[1]!
    await updateReview(dir, (d) => setEntry(d, 'scenarios', outline.key, { status: 'approved', text_hash: outline.hash, approved_commit: 'x', at: 'now' }))
    process.env.FAKE_CLAUDE_TEXT = `Rows weigh by age.\n\n\`\`\`diff\n${await decisionDiff(repo)}\`\`\`\n`
    const { json } = await call(app, 'POST', base, { anchor: 'scenario', ref: OUTLINE, text: 'Record it?' })
    await questions.idle(dir)
    const applied = await call(app, 'POST', `${base}/${json.id}/patches/1/apply`, { summary: 'rows weigh by business-hour age' })
    expect(applied.status).toBe(200)
    expect(applied.json.commit).toBe(await headSha(repo))
    expect(await git(repo, ['log', '-1', '--format=%B'])).toMatch(/^docs\(openspec\): add-thread-state — rows weigh by business-hour age \(owner decision\)\n\nCo-Authored-By: Test <test@example.com>\n/)
    expect(await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toContain(`${REL}/review.yaml`)
    expect((await readReview(dir)).threads[0]!.messages[1]!.patch).toMatchObject({ state: 'applied', commit: applied.json.commit })
    const after = await call(app, 'GET', `/api/changes/${wt!.id}/add-thread-state`)
    expect(after.json.features[0].scenarios[1].effective).toMatchObject({ status: 'pending', changedSinceApproval: true })
  })

  it('reverts the working tree when the commit fails', async () => {
    const { repo, app, questions, dir, base } = await setup()
    process.env.FAKE_CLAUDE_TEXT = `Yes.\n\n\`\`\`diff\n${await decisionDiff(repo)}\`\`\`\n`
    const { json } = await call(app, 'POST', base, { anchor: 'scenario', ref: OUTLINE, text: 'Record it?' })
    await questions.idle(dir)
    await writeFile(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const res = await call(app, 'POST', `${base}/${json.id}/patches/1/apply`, { summary: 'x' })
    expect(res.json.error.code).toBe('command_failed')
    expect(await readFile(path.join(repo, FEATURE), 'utf8')).not.toContain('rows weigh by business-hour age')
    expect((await readReview(dir)).threads[0]!.messages[1]!.patch!.state).toBe('proposed')
  })

  it('refuses to apply while an Apply run is active', async () => {
    const { repo, app, questions, dir, base } = await setup({ applyActive: true })
    process.env.FAKE_CLAUDE_TEXT = `Yes.\n\n\`\`\`diff\n${await decisionDiff(repo)}\`\`\`\n`
    const { json } = await call(app, 'POST', base, { anchor: 'scenario', ref: OUTLINE, text: 'Record it?' })
    await questions.idle(dir)
    expect((await call(app, 'POST', `${base}/${json.id}/patches/1/apply`, { summary: 'x' })).json.error.code).toBe('apply_running')
  })

  it('records a timeout as an agent message and leaves the thread open', async () => {
    const { app, questions, dir, base } = await setup({ timeoutMs: 300 })
    process.env.FAKE_CLAUDE_MODE = 'hang'
    await call(app, 'POST', base, { anchor: 'change', ref: '', text: 'Slow?' })
    await questions.idle(dir)
    const thread = (await readReview(dir)).threads[0]!
    expect(thread.status).toBe('open')
    expect(thread.messages[1]!.text).toMatch(/did not answer: timed out/)
  })

  it('validates anchors and resolves threads', async () => {
    const { app, questions, dir, base } = await setup()
    expect((await call(app, 'POST', base, { anchor: 'scenario', ref: 'features/x.feature::Nope', text: 'Hm?' })).json.error.code).toBe('unknown_scenario')
    expect((await call(app, 'POST', base, { anchor: 'scenario', ref: OUTLINE, text: '   ' })).json.error.code).toBe('invalid_body')
    process.env.FAKE_CLAUDE_TEXT = 'Ok.'
    const { json } = await call(app, 'POST', base, { anchor: 'change', ref: '', text: 'Done?' })
    await questions.idle(dir)
    await call(app, 'POST', `${base}/${json.id}/resolve`)
    expect((await readReview(dir)).threads[0]!.status).toBe('resolved')
    expect((await call(app, 'POST', `${base}/t_nope/resolve`)).json.error.code).toBe('unknown_thread')
  })
})
