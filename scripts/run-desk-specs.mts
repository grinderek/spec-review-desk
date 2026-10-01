import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { createBaseApp } from '../server/app.ts'
import { contractHash, parseDeskDsl, type DeskScenario } from '../server/desk-dsl.ts'
import { corpusKey } from '../server/run-messages.ts'
import { headSha } from '../server/git.ts'
import { QuestionService } from '../server/questions.ts'
import { readReviewEvents, REVIEW_FILE, setEntry, updateReview } from '../server/review-store.ts'
import { registerReadRoutes } from '../server/routes/read.ts'
import { registerReviewRoutes } from '../server/routes/review.ts'
import { call, testContext } from '../server/testing/http.ts'
import { sh, writeFiles } from '../server/testing/repo.ts'

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
for (const file of files) {
  const doc = parseDeskDsl(await readFile(path.join(root, file), 'utf8'), `features/${file}`)
  for (const scenario of doc.scenarios) {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'desk-dsl-'))
    try {
      sh(repo, 'git', ['init', '-q', '-b', 'main'])
      sh(repo, 'git', ['config', 'user.email', 'spec@example.com'])
      sh(repo, 'git', ['config', 'user.name', 'Desk specs'])
      const dir = path.join(repo, 'openspec/changes/subject')
      const subjectFile = path.join(dir, 'features/subject.desk.yaml')
      const subject: DeskScenario = { id: 'subject', scenario: 'Subject contract', given: [], when: { Inspect: {} }, then: { events: [], response: { status: 200 } } }
      await writeFiles(repo, { 'README.md': 'DSL fixture\n', 'openspec/changes/subject/.openspec.yaml': 'schema: behavior-driven\n', 'openspec/changes/subject/specs/subject/spec.md': '#### Scenario: Subject contract\n' })
      sh(repo, 'git', ['add', '-A']); sh(repo, 'git', ['commit', '-q', '-m', 'fixture'])
      const ctx = testContext(repo)
      const app = createBaseApp(ctx)
      const questions = new QuestionService({ config: ctx.config, bus: ctx.bus })
      registerReadRoutes(app, ctx, { codex: false, docker: false })
      registerReviewRoutes(app, ctx, { questions })
      const vars: Record<string, string> = { key: 'features/subject.desk.yaml::subject', hash: contractHash(subject), head: await headSha(repo), at: '2026-10-01T00:00:00.000Z' }
      const resolve = (value: unknown): any => {
        if (typeof value === 'string') return value.replace(/\$([a-z]+)/g, (_, name: string) => { if (!(name in vars)) throw Error(`Unknown binding $${name}`); return vars[name]! })
        if (Array.isArray(value)) return value.map(resolve)
        return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, resolve(v)])) : value
      }
      for (const fact of scenario.given) {
        const [name, raw] = Object.entries(fact)[0]!
        const data = resolve(raw)
        if (name === 'ScenarioDiscovered' || name === 'ScenarioRevised') {
          // A repository fact changes the source contract, not private application state.
          if (data.status) subject.then.response.status = Number(data.status)
          await mkdir(path.dirname(subjectFile), { recursive: true })
          await writeFile(subjectFile, stringify({ version: 1, feature: 'Subject', scenarios: [subject] }))
          vars.hash = contractHash(subject)
        } else if (name === 'ScenarioApproved' || name === 'ScenarioChangesRequested') {
          await updateReview(dir, (review) => setEntry(review, 'scenarios', data.key, { status: name === 'ScenarioApproved' ? 'approved' : 'changes_requested', text_hash: data.hash, approved_commit: data.commit ?? null, at: data.at }))
        } else if (name === 'ScenarioReformatted') await writeFile(subjectFile, '# Presentation-only change\n' + stringify({ scenarios: [subject], feature: 'Subject', version: 1 }))
        else if (name === 'ContractSourceWritten') await writeFile(subjectFile, data.source)
        else if (name === 'ReviewProjectionLost') await rm(path.join(dir, REVIEW_FILE), { force: true })
        else if (name === 'ChangeArchived') {
          const archive = path.join(repo, 'openspec/changes/archive/subject')
          await mkdir(path.dirname(archive), { recursive: true }); await rename(dir, archive)
        } else throw Error(`Unsupported Given event ${name}`)
      }
      await call(app, 'GET', '/api/changes')
      const wt = ctx.registry.all()[0]!
      vars.change = `/api/changes/${wt.id}/subject`
      const archived = scenario.given.some((fact) => 'ChangeArchived' in fact)
      const eventDir = archived ? path.join(repo, 'openspec/changes/archive/subject') : dir
      const before = await readReviewEvents(eventDir)
      const [command, raw] = Object.entries(scenario.when)[0]!
      const data = resolve(raw)
      const commands: Record<string, { method: string; path: string; body?: unknown }> = {
        ApproveScenario: { method: 'POST', path: `${vars.change}/scenarios/approve`, body: { key: data.key } },
        RevokeScenarioApproval: { method: 'POST', path: `${vars.change}/scenarios/revoke`, body: { key: data.key } },
        ReadChange: { method: 'GET', path: vars.change! },
      }
      const request = commands[command]
      if (!request) throw Error(`Unsupported command ${command}`)
      const response = await call(app, request.method, request.path, request.body)
      subset(resolve(scenario.then.response), { status: response.status, body: response.json })
      const actual = (await readReviewEvents(eventDir)).slice(before.length)
      assert.equal(actual.length, scenario.then.events.length, 'events: exact number appended')
      scenario.then.events.forEach((fact, i) => {
        const [name, fields] = Object.entries(fact)[0]!
        const event = actual[i]!
        assert.equal(event.type, name, `events[${i}].type`)
        const payload = 'entry' in event ? { key: event.key, hash: event.entry.text_hash, commit: event.entry.approved_commit, at: event.entry.at } : { key: event.key }
        subset(resolve(fields), payload, `events[${i}]`)
      })
      passed++; console.log(`PASS ${scenario.scenario}`)
      report.push({ file: `features/${file}`, id: scenario.id, title: scenario.scenario, status: 'passed' })
    } catch (error) {
      failed++; const message = error instanceof Error ? error.message : String(error)
      console.error(`FAIL ${scenario.scenario}: ${message}`)
      report.push({ file: `features/${file}`, id: scenario.id, title: scenario.scenario, status: 'failed', message })
    } finally { await rm(repo, { recursive: true, force: true }) }
  }
}
await mkdir('.spec-review', { recursive: true })
await writeFile('.spec-review/desk-spec-results.json', JSON.stringify({ version: 1, passed, failed, scenarios: report }, null, 2))
console.log(`${passed} passed, ${failed} failed`)
await writeFile('.spec-review/last-run.ndjson', [...report.map((result) => JSON.stringify({ deskScenarioResult: { key: corpusKey(String(result.file), String(result.title)), status: result.status, message: result.message ?? null } })), JSON.stringify({ deskRunFinished: { at: new Date().toISOString() } })].join('\n') + '\n')
process.exitCode = failed ? 1 : 0
