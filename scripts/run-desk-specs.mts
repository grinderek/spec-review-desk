import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDeskDsl } from '../server/desk-dsl.ts'
import { corpusKey } from '../server/run-messages.ts'
import type { ReviewEvent } from '../server/review-store.ts'
import { ReviewWorld } from '../server/testing/review-world.ts'

const root = path.resolve('features')
const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.desk.yaml')).sort()
if (!files.length) throw new Error('No Desk DSL specifications found')
let passed = 0, failed = 0
const report: Record<string, unknown>[] = []
function subset(expected: unknown, actual: unknown, field = 'response'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${field}: expected array`)
    assert.equal(actual.length, expected.length, `${field}: array length`)
    expected.forEach((value, i) => subset(value, actual[i], `${field}[${i}]`))
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${field}: expected object`)
    for (const [key, value] of Object.entries(expected)) subset(value, (actual as Record<string, unknown>)[key], `${field}.${key}`)
  } else assert.deepEqual(actual, expected, field)
}
function bind(world: ReviewWorld, bindings: Record<string, string> | undefined, response: unknown): void {
  for (const [name, selector] of Object.entries(bindings ?? {})) {
    const value = selector.split('.').reduce<any>((object, key) => object?.[key], { response })
    assert.ok(typeof value === 'string' && value.length > 0, `${selector}: expected a generated non-empty string`)
    if (name in world.vars) assert.equal(world.vars[name], value, `binding $${name} changed`)
    world.vars[name] = value
  }
}
function payload(event: ReviewEvent): unknown {
  if ('entry' in event) return { key: event.key, hash: event.entry.text_hash, commit: event.entry.approved_commit, at: event.entry.at, ...('thread' in event && event.thread ? { thread: event.thread } : {}) }
  if ('key' in event) return { key: event.key }
  if ('commit' in event) return { at: event.at, commit: event.commit }
  return {}
}
for (const file of files) {
  const doc = parseDeskDsl(await readFile(path.join(root, file), 'utf8'), `features/${file}`)
  for (const scenario of doc.scenarios) {
    const cases = scenario.cases ?? [{}]
    for (const [row, parameters] of cases.entries()) {
      const world = await ReviewWorld.create()
      const label = scenario.cases ? `${scenario.scenario} [${parameters.name ?? row + 1}]` : scenario.scenario
      const result = { file: `features/${file}`, id: scenario.id, title: scenario.scenario, row: scenario.cases ? row : null, rows: scenario.cases?.length ?? null }
      try {
        Object.assign(world.vars, parameters)
        for (const fact of scenario.given) {
          const [name, raw] = Object.entries(world.resolve(fact))[0]!
          await world.given(name, world.resolve(raw))
        }
        await world.ready()
        const before = await world.events()
        const [command, raw] = Object.entries(world.resolve(scenario.when))[0]!
        const response = await world.command(command, world.resolve(raw))
        bind(world, scenario.then.bind, response)
        subset(world.resolve(scenario.then.response), response)
        const actual = (await world.events()).slice(before.length)
        assert.equal(actual.length, scenario.then.events.length, 'events: exact number appended')
        scenario.then.events.forEach((fact, i) => {
          const [name, fields] = Object.entries(world.resolve(fact))[0]!
          assert.equal(actual[i]!.type, name, `events[${i}].type`)
          subset(world.resolve(fields), payload(actual[i]!), `events[${i}]`)
        })
        for (const [i, observation] of (scenario.then.reads ?? []).entries()) {
          const observed = await world.read(world.resolve(observation.path))
          subset(world.resolve(observation.response), observed, `reads[${i}]`)
        }
        // Observing a public view must not change history.
        assert.deepEqual(await world.events(), [...before, ...actual], 'Then reads appended events')
        passed++; console.log(`PASS ${label}`)
        report.push({ ...result, status: 'passed' })
      } catch (error) {
        failed++; const message = error instanceof Error ? error.message : String(error)
        console.error(`FAIL ${label}: ${message}`)
        report.push({ ...result, status: 'failed', message })
      } finally { await world.close() }
    }
  }
}
await mkdir('.spec-review', { recursive: true })
await writeFile('.spec-review/desk-spec-results.json', JSON.stringify({ version: 1, passed, failed, scenarios: report }, null, 2))
console.log(`${passed} passed, ${failed} failed`)
await writeFile('.spec-review/last-run.ndjson', [...report.map((result) => JSON.stringify({ deskScenarioResult: { key: corpusKey(String(result.file), String(result.title)), status: result.status, message: result.message ?? null, row: result.row, rows: result.rows } })), JSON.stringify({ deskRunFinished: { at: new Date().toISOString() } })].join('\n') + '\n')
process.exitCode = failed ? 1 : 0
