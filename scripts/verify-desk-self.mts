import assert from 'node:assert/strict'
import { loadConfig } from '../server/config.ts'
import { createBaseApp } from '../server/app.ts'
import { EventBus } from '../server/events.ts'
import { Registry, discover } from '../server/discovery.ts'
import { RunnerService } from '../server/runner.ts'
import { registerReadRoutes } from '../server/routes/read.ts'
import { registerRunnerRoutes } from '../server/routes/runner.ts'
import { call } from '../server/testing/http.ts'
import { corpusReport } from '../server/corpus.ts'
import { loadChangeView } from '../server/change-view.ts'
import { corpusKey } from '../server/run-messages.ts'

// Exercise the self-review integration through authenticated public runner routes.
// No owner approvals are written in the actual repository.
const config = await loadConfig('config.desk.yaml')
const ctx = { config, token: 'test-token', bus: new EventBus(), registry: new Registry() }
const runner = new RunnerService({ profiles: config.runners, bus: ctx.bus })
const app = createBaseApp(ctx)
registerReadRoutes(app, ctx, { codex: false, docker: false })
registerRunnerRoutes(app, ctx, runner)
const trees = await discover(config.repos, ctx.registry)
const wt = trees.flatMap(t => t.worktrees).find(w => w.path === process.cwd())!
assert.ok(wt, 'Desk must discover its configured worktree')
const ref = wt.changes.find(c => c.name === 'try-desk-dsl')!
assert.ok(ref, 'The proposed self-review change must exist')
const view = await loadChangeView(wt, ref, { withCommits: false })
assert.equal(view.joinKey.ok, true)
assert.deepEqual(view.errors, [])
const scenarios = view.features.flatMap(f => f.scenarios)
assert.ok(scenarios.length > 0)
assert.ok(Object.values((await corpusReport(wt, view)).states).every(s => s === 'same'))
const expected = scenarios.reduce((n, s) => n + (s.examples.reduce((rows, e) => rows + e.rows.length, 0) || 1), 0)
assert.equal((await call(app, 'POST', `/api/runner/${wt.id}/run`)).status, 202)
await runner.idle(wt.path)
const state = (await call(app, 'GET', `/api/runner/${wt.id}`)).json.state
assert.equal(state.execution, 'local')
assert.equal(state.error, null)
assert.equal(Object.keys(state.result.scenarios).length, scenarios.length)
assert.deepEqual(state.result.totals, { passed: expected, failed: 0, other: 0 })
for (const scenario of scenarios) {
  const result = state.result.scenarios[corpusKey(scenario.file, scenario.title)]
  assert.equal(result.status, 'passed', scenario.title)
  const rows = scenario.examples.flatMap(e => e.rows)
  assert.deepEqual(result.rows, rows.length ? rows.map(() => 'passed') : null, scenario.title)
}
console.log(`PASS Desk self-review: ${scenarios.length} matching contracts, ${expected} executions, authenticated local runner and every case result.`)
