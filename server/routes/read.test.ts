import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBaseApp } from '../app.ts'
import { worktreeId } from '../discovery.ts'
import { headSha } from '../git.ts'
import { emptyReview, setEntry, writeReview } from '../review-store.ts'
import { call, TEST_PORT, TEST_TOKEN, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerReadRoutes } from './read.ts'

const KEY = "features/thread_state.feature::The founder's reply resolves a waiting thread"

async function setup() {
  const { repo } = await makeRepo()
  const ctx = testContext(repo)
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { codex: true, docker: false })
  return { repo, ctx, app, wt: worktreeId(repo) }
}

describe('read routes', () => {
  it('lists behavior-driven changes with counters', async () => {
    const { app, wt } = await setup()
    const res = await call(app, 'GET', '/api/changes')
    expect(res.status).toBe(200)
    expect(res.json.repos[0].worktrees[0].id).toBe(wt)
    expect(res.json.repos[0].worktrees[0].changes).toEqual([expect.objectContaining({ name: 'add-thread-state', approved: 0, total: 2 })])
  })

  it('returns one change view and 404s for unknown ones', async () => {
    const { app, wt } = await setup()
    await call(app, 'GET', '/api/changes')
    expect((await call(app, 'GET', `/api/changes/${wt}/add-thread-state`)).json.name).toBe('add-thread-state')
    expect((await call(app, 'GET', `/api/changes/${wt}/nope`)).json.error.code).toBe('unknown_change')
    expect((await call(app, 'GET', `/api/changes/0000000000/add-thread-state`)).status).toBe(404)
  })

  it('diffs a scenario against the commit it was approved at', async () => {
    const { app, repo, wt } = await setup()
    const dir = path.join(repo, 'openspec/changes/add-thread-state')
    await writeReview(dir, setEntry(emptyReview(), 'scenarios', KEY, { status: 'approved', text_hash: 'old', approved_commit: await headSha(repo), at: 'now' }))
    const file = path.join(dir, 'features/thread_state.feature')
    await writeFile(file, (await readFile(file, 'utf8')).replace('| components.inbox.display_score | 100 |', '| components.inbox.display_score | 97 |'))
    await call(app, 'GET', '/api/changes')
    const res = await call(app, 'GET', `/api/changes/${wt}/add-thread-state/scenario-diff?key=${encodeURIComponent(KEY)}`)
    expect(res.json.before).toContain('| 100 |')
    expect(res.json.after).toContain('| 97 |')
  })

  it('streams bus events over SSE', async () => {
    const { app, ctx } = await setup()
    const res = await app.request(`http://127.0.0.1:${TEST_PORT}/api/events`, {
      headers: { host: `127.0.0.1:${TEST_PORT}`, cookie: `sr_token=${TEST_TOKEN}` },
    })
    const reader = res.body!.getReader()
    await reader.read()
    ctx.bus.publish('change', { worktreeId: 'w', name: 'n' })
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('"topic":"change"')
    await reader.cancel()
  })
})
