import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApplyService } from '../apply.ts'
import { createBaseApp } from '../app.ts'
import { addDecisions, decisionsFromReply } from '../decision-model.ts'
import { worktreeId } from '../discovery.ts'
import { EventBus } from '../events.ts'
import { updateReview, upsertApplyRun } from '../review-store.ts'
import { FAKE_CODEX } from '../testing/fake-codex-path.ts'
import { call, testConfig, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerApplyRoutes } from './apply.ts'
import { registerReadRoutes } from './read.ts'

const REL = 'openspec/changes/add-thread-state'

async function setup() {
  const { hub, repo } = await makeRepo()
  const ctx = testContext(repo, { codexBin: FAKE_CODEX })
  const apply = new ApplyService({ config: testConfig(repo, { codexBin: FAKE_CODEX }), bus: new EventBus() })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { codex: true, docker: false })
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
      upsertApplyRun(d, {
        id: 'r_escape', session: 's', pid: null, log: '../secret.txt', started_at: 'then', ended_at: null, outcome: 'done', resume_offset: 0,
      }))
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
    await updateReview(dir, (d) => upsertApplyRun(d, { id: 'r_ok', session: 's', pid: null, log, started_at: 'then', ended_at: null, outcome: 'done', resume_offset: 0 }))
    const res = await call(app, 'GET', `/api/changes/${wt}/add-thread-state/runs/r_ok/log`)
    expect(res.status).toBe(200)
    expect(res.json.text).toBe('hi')
  })
})

describe('resume with decisions route', () => {
  it('refuses an unknown run, a run that is not waiting, pending decisions and a bad body', async () => {
    const { app, dir, wt } = await setup()
    const url = `/api/changes/${wt}/add-thread-state/apply/resume`
    const run = (id: string, outcome: 'done' | 'needs_owner') => ({
      id, session: 's', pid: null, log: `.spec-review/runs/${id}.ndjson`, started_at: 'then', ended_at: 'now', outcome, resume_offset: 0,
    })
    expect((await call(app, 'POST', url, { runId: 'r_nope' })).json.error.code).toBe('unknown_run')
    await updateReview(dir, (d) => upsertApplyRun(d, run('r_done', 'done')))
    expect((await call(app, 'POST', url, { runId: 'r_done' })).json.error.code).toBe('run_not_waiting')
    const pending = decisionsFromReply(
      [{
        id: 'cc', question: 'CC?', scope: { kind: 'change' }, recommended: null, blocking: true,
        options: [{ id: 'a', label: 'A', consequence: 'a.' }, { id: 'b', label: 'B', consequence: 'b.' }],
      }],
      { kind: 'apply', run: 'r_wait' },
      'now',
    )
    await updateReview(dir, (d) => addDecisions(upsertApplyRun(d, run('r_wait', 'needs_owner')), pending))
    expect((await call(app, 'POST', url, { runId: 'r_wait' })).json.error.code).toBe('decisions_pending')
    expect((await call(app, 'POST', url, {})).json.error.code).toBe('invalid_body')
  })
})
