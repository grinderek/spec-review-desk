import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApplyService } from '../apply.ts'
import { createBaseApp } from '../app.ts'
import { worktreeId } from '../discovery.ts'
import { EventBus } from '../events.ts'
import { updateReview, upsertApplyRun } from '../review-store.ts'
import { FAKE_CLAUDE } from '../testing/fake-claude-path.ts'
import { call, testConfig, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerApplyRoutes } from './apply.ts'
import { registerReadRoutes } from './read.ts'

const REL = 'openspec/changes/add-thread-state'

async function setup() {
  const { hub, repo } = await makeRepo()
  const ctx = testContext(repo, { claudeBin: FAKE_CLAUDE })
  const apply = new ApplyService({ config: testConfig(repo, { claudeBin: FAKE_CLAUDE }), bus: new EventBus() })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { claude: true, docker: false })
  registerApplyRoutes(app, ctx, { apply })
  const wt = worktreeId(repo)
  await call(app, 'GET', '/api/changes')
  const dir = path.join(repo, REL)
  return { hub, repo, app, dir, wt }
}

describe('apply routes', () => {
  it("refuses to read a run log whose path escapes .spec-review/runs/, even though the file exists", async () => {
    const { hub, repo, app, dir, wt } = await setup()
    const secret = path.join(hub, 'secret.txt')
    await writeFile(secret, 'TOP SECRET CONTENT')
    await updateReview(dir, (d) =>
      upsertApplyRun(d, { id: 'r_escape', session: 's', pid: null, log: '../secret.txt', started_at: 'then', ended_at: null, outcome: 'done' }))
    const res = await call(app, 'GET', `/api/changes/${wt}/add-thread-state/runs/r_escape/log`)
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('invalid_run_log')
    expect(JSON.stringify(res.json)).not.toContain('TOP SECRET')
  })

  it('reads a run log that resolves under .spec-review/runs/', async () => {
    const { repo, app, dir, wt } = await setup()
    const log = '.spec-review/runs/r_ok.ndjson'
    await mkdir(path.join(repo, '.spec-review/runs'), { recursive: true })
    await writeFile(path.join(repo, log), '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n')
    await updateReview(dir, (d) => upsertApplyRun(d, { id: 'r_ok', session: 's', pid: null, log, started_at: 'then', ended_at: null, outcome: 'done' }))
    const res = await call(app, 'GET', `/api/changes/${wt}/add-thread-state/runs/r_ok/log`)
    expect(res.status).toBe(200)
    expect(res.json.text).toBe('hi')
  })
})
