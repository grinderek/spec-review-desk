import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBaseApp } from '../app.ts'
import { listChanges, worktreeId } from '../discovery.ts'
import { git, headSha } from '../git.ts'
import { QuestionService } from '../questions.ts'
import { readReview, setEntry, updateReview } from '../review-store.ts'
import { FAKE_CLAUDE, resetFakeClaude } from '../testing/fake-claude-path.ts'
import { call, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { approveEverything } from '../testing/review.ts'
import { registerReadRoutes } from './read.ts'
import { registerReviewRoutes } from './review.ts'

const FIRST = "features/thread_state.feature::The founder's reply resolves a waiting thread"

async function setup() {
  const { repo } = await makeRepo()
  const ctx = testContext(repo, { claudeBin: FAKE_CLAUDE })
  const questions = new QuestionService({ config: ctx.config, bus: ctx.bus })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { claude: true, docker: false })
  registerReviewRoutes(app, ctx, { questions })
  await call(app, 'GET', '/api/changes')
  const wt = ctx.registry.all()[0]!
  const ref = (await listChanges(wt))[0]!
  return { repo, app, questions, wt, ref, base: `/api/changes/${worktreeId(repo)}/add-thread-state`, dir: path.join(repo, 'openspec/changes/add-thread-state') }
}

beforeEach(() => {
  resetFakeClaude()
  process.env.FAKE_CLAUDE_MODE = 'answer'
  process.env.FAKE_CLAUDE_TEXT = 'Noted.'
  delete process.env.FAKE_CLAUDE_LOG
})

describe('review routes', () => {
  it('approves a scenario with its current hash and HEAD, and revokes it', async () => {
    const { repo, app, base, dir } = await setup()
    expect((await call(app, 'POST', `${base}/scenarios/approve`, { key: FIRST })).status).toBe(200)
    const entry = (await readReview(dir)).scenarios[FIRST]!
    expect(entry).toMatchObject({ status: 'approved', approved_commit: await headSha(repo) })
    const view = await call(app, 'GET', base)
    expect(view.json.features[0].scenarios[0].effective.status).toBe('approved')
    await call(app, 'POST', `${base}/scenarios/revoke`, { key: FIRST })
    expect((await readReview(dir)).scenarios[FIRST]).toBeUndefined()
  })

  it('opens a thread when changes are requested', async () => {
    const { app, base, dir, questions } = await setup()
    const res = await call(app, 'POST', `${base}/scenarios/request-changes`, { key: FIRST, reason: 'The 100 looks wrong.' })
    await questions.idle(dir)
    const review = await readReview(dir)
    expect(review.scenarios[FIRST]!.status).toBe('changes_requested')
    expect(review.threads[0]).toMatchObject({ id: res.json.threadId, anchor: 'scenario', ref: FIRST })
    expect(review.threads[0]!.messages[0]!.text).toBe('The 100 looks wrong.')
  })

  it('approves phrases by key, extensions included', async () => {
    const { app, base, dir } = await setup()
    await call(app, 'POST', `${base}/phrases/approve`, { key: 'Gmail finished syncing at {string}#extension' })
    expect(Object.keys((await readReview(dir)).phrases)).toEqual(['Gmail finished syncing at {string}#extension'])
    expect((await call(app, 'POST', `${base}/phrases/approve`, { key: 'nope' })).json.error.code).toBe('unknown_phrase')
  })

  it('refuses to record approval before the change is ready, then commits it', async () => {
    const { repo, app, base, dir, wt, ref } = await setup()
    const early = await call(app, 'POST', `${base}/approval`)
    expect(early.status).toBe(409)
    expect(early.json.error).toMatchObject({ code: 'not_ready', message: expect.stringContaining('2 scenarios not approved') })
    await approveEverything(wt, ref)
    const res = await call(app, 'POST', `${base}/approval`)
    expect(res.status).toBe(200)
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): add-thread-state — owner approval')
    const review = await readReview(dir)
    expect(review.approved_commit).toBe(await git(repo, ['rev-parse', '--short', 'HEAD~1']).then((s) => s.trim()))
    expect(review.approved_at).not.toBeNull()
  })

  it('drops and re-attaches orphaned entries', async () => {
    const { app, base, dir } = await setup()
    const orphan = { status: 'approved' as const, text_hash: 'x', approved_commit: null, at: 'now' }
    await updateReview(dir, (d) => setEntry(setEntry(d, 'scenarios', 'features/old.feature::Old', orphan), 'scenarios', 'features/gone.feature::Gone', orphan))
    await call(app, 'POST', `${base}/orphans/drop`, { section: 'scenarios', key: 'features/gone.feature::Gone' })
    await call(app, 'POST', `${base}/orphans/reattach`, { section: 'scenarios', key: 'features/old.feature::Old', to: FIRST })
    expect(Object.keys((await readReview(dir)).scenarios)).toEqual([FIRST])
  })

  it('rejects writes to archived changes', async () => {
    const { app, repo } = await setup()
    await mkdir(path.join(repo, 'openspec/changes/archive'), { recursive: true })
    await rename(path.join(repo, 'openspec/changes/add-thread-state'), path.join(repo, 'openspec/changes/archive/2026-09-20-add-thread-state'))
    const res = await call(app, 'POST', `/api/changes/${worktreeId(repo)}/2026-09-20-add-thread-state/scenarios/approve`, { key: FIRST })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('archived')
  })
})
