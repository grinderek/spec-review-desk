import assert from 'node:assert/strict'
import { loadConfig } from '../server/config.ts'
import { createBaseApp } from '../server/app.ts'
import { EventBus } from '../server/events.ts'
import { Registry, discover } from '../server/discovery.ts'
import { RunnerService } from '../server/runner.ts'
import { registerReadRoutes } from '../server/routes/read.ts'
import { registerRunnerRoutes } from '../server/routes/runner.ts'
import { call } from '../server/testing/http.ts'
import { compareToCorpus, loadCorpus } from '../server/corpus.ts'
import { loadChangeView } from '../server/change-view.ts'

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
const corpus = await loadCorpus(wt.path)
assert.deepEqual(corpus.errors, [])
const reviewedScenarios = []
for (const name of ['scenario-approval-reading', 'discussion-decision-reading', 'initiative-and-catalog-reading', 'product-onboarding', 'multi-repository-verification']) {
  const ref = wt.changes.find(c => !c.archived && c.name === name)
  assert.ok(ref, `The proposed self-review change ${name} must exist`)
  const view = await loadChangeView(wt, ref, { withCommits: false })
  assert.equal(view.validation.valid, true, name)
  assert.deepEqual(view.errors, [], name)
  assert.ok(Object.values(compareToCorpus(view.features, corpus.features, view.review.approved_at !== null).states).every(s => s === 'same'), name)
  reviewedScenarios.push(...view.features.flatMap(f => f.scenarios))
}
assert.ok(reviewedScenarios.length > 0)
// The runner executes the whole DSL corpus, beyond the contracts in the self-review change.
const scenarios = corpus.features.filter(f => f.tags.includes('desk-dsl')).flatMap(f => f.scenarios)
assert.ok(scenarios.length > 0)
const expectedKeys = scenarios.map(s => s.key).sort()
assert.deepEqual(reviewedScenarios.map(s => s.key).sort(), expectedKeys, 'Review packages must cover the whole product corpus exactly once')
assert.equal(new Set(expectedKeys).size, expectedKeys.length, 'Corpus runner keys must be unique')
const expected = scenarios.reduce((n, s) => n + (s.examples.reduce((rows, e) => rows + e.rows.length, 0) || 1), 0)
assert.equal((await call(app, 'POST', `/api/runner/${wt.id}/run`)).status, 202)
await runner.idle(wt.path)
const state = (await call(app, 'GET', `/api/runner/${wt.id}`)).json.state
assert.equal(state.execution, 'local')
assert.equal(state.error, null)
assert.equal(state.outcome, 'done')
assert.equal(state.stale, false, 'The corpus result must match the final working tree')
assert.deepEqual(Object.keys(state.result.scenarios).sort(), expectedKeys)
assert.deepEqual(state.result.totals, { passed: expected, failed: 0, other: 0 })
for (const scenario of scenarios) {
  const result = state.result.scenarios[scenario.key]
  assert.equal(result.status, 'passed', scenario.title)
  const rows = scenario.examples.flatMap(e => e.rows)
  assert.deepEqual(result.rows, rows.length ? rows.map(() => 'passed') : null, scenario.title)
}
console.log(`PASS Desk self-review: ${scenarios.length} corpus contracts, ${expected} executions, ${reviewedScenarios.length} matching review contracts, authenticated local runner and every case result.`)
