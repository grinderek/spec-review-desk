import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBaseApp } from '../app.ts'
import { worktreeId } from '../discovery.ts'
import { git } from '../git.ts'
import { initiativeDir, type RunRecord, updateInitiative } from '../initiative-store.ts'
import { FINISHERS } from '../run-kinds.ts'
import { InitiativeRunService } from '../run-service.ts'
import { FAKE_OPENSPEC, resetFakeClaude } from '../testing/fake-claude-path.ts'
import { FakeSandbox } from '../testing/fake-sandbox.ts'
import { FEATURE, NEW_STEPS_MD, SPEC_MD } from '../testing/fixtures.ts'
import { call, callForm, TEST_PORT, TEST_TOKEN, testContext } from '../testing/http.ts'
import { makeRepo } from '../testing/repo.ts'
import { registerInitiativeDecisionRoutes } from './initiative-decisions.ts'
import { registerInitiativeRoutes } from './initiatives.ts'
import { registerReadRoutes } from './read.ts'

const option = (id: string) => ({ id, label: id, consequence: `${id}.` })
const CHANGE = 'add-health-score-engine'
let tmp = ''

async function setup() {
  const { hub, repo } = await makeRepo()
  const ctx = testContext(repo, { hubRoot: hub, openspecBin: FAKE_OPENSPEC })
  const sandbox = new FakeSandbox()
  const runs = new InitiativeRunService({ config: ctx.config, bus: ctx.bus, sandbox, finishers: FINISHERS })
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, { claude: true, docker: true })
  registerInitiativeRoutes(app, ctx, { runs, sandbox })
  registerInitiativeDecisionRoutes(app, ctx)
  return { hub, repo, app, runs, sandbox, bus: ctx.bus }
}

// A request whose declared Content-Length exceeds the multipart ceiling, without an actual
// oversized body: Hono's bodyLimit reads the header and refuses before touching the stream, so
// this exercises the pre-buffering refusal cheaply (no 100 MB allocation in the test process).
async function oversizedPost(app: Awaited<ReturnType<typeof setup>>['app'], url: string) {
  const res = await app.request(`http://127.0.0.1:${TEST_PORT}${url}`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${TEST_PORT}`,
      origin: `http://127.0.0.1:${TEST_PORT}`,
      cookie: `sr_token=${TEST_TOKEN}`,
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(200 * 1024 * 1024),
    },
    body: 'tiny',
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function create(app: Awaited<ReturnType<typeof setup>>['app']) {
  const form = new FormData()
  form.set('name', 'health-score')
  form.set('repo', 'api')
  form.set('where', 'new')
  form.set('base', 'main')
  form.set('title', 'Business health score')
  form.set('brief', '# What\n\nScore the founder day.')
  form.append('files', new File(['# Spec\n'], 'spec.md', { type: 'text/markdown' }))
  form.set('fromRepo', 'api/features/STEPS.md')
  return callForm(app, '/api/initiatives', form)
}

beforeEach(async () => {
  resetFakeClaude()
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-initiative-routes-'))
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_MODE = 'answer'
  process.env.FAKE_OPENSPEC_LOG = path.join(tmp, 'openspec.ndjson')
  delete process.env.FAKE_OPENSPEC_FAIL
})

describe('initiative routes', () => {
  it('New feature → planner draft → edit → approve → propose s1 → the change exists, committed and tagged', async () => {
    const { repo, app, runs } = await setup()
    const created = await create(app)
    expect(created.status).toBe(201)
    const wt = path.join(repo, '.claude/worktrees/health-score')
    expect(created.json).toEqual({ worktreeId: worktreeId(wt), name: 'health-score' })
    const url = `/api/initiatives/${created.json.worktreeId}/health-score`
    const listed = (await call(app, 'GET', '/api/initiatives')).json
    expect(listed.initiatives[0]).toMatchObject({ name: 'health-score', planStatus: 'none', total: 0 })
    expect(listed.defaultBase).toBe('main')
    expect(listed.repos[0]).toMatchObject({ name: 'api', path: repo })
    expect(listed.repos[0].worktrees.map((w: { branch: string }) => w.branch).sort()).toEqual(['main', 'plan/health-score'])

    await writeFile(path.join(tmp, 'replies.json'), JSON.stringify([
      { match: 'Slice s1', reply: { answer: 'Wrote s1.', patch: null, decisions: [], resolves: [], status: 'done', change: CHANGE } },
      {
        match: 'Propose how to slice',
        reply: {
          answer: 'Two slices.', patch: null, resolves: [], status: 'done',
          decisions: [{ id: 'flag', question: 'Behind a flag?', scope: { kind: 'change' }, options: [option('yes'), option('no')], recommended: 'yes', blocking: true }],
          slices: [{ title: 'Engine', scope: 'The engine.', depends_on: [] }, { title: 'Delivery', scope: 'Delivery.', depends_on: [1] }],
        },
      },
    ]))
    process.env.FAKE_CLAUDE_REPLIES_FILE = path.join(tmp, 'replies.json')
    await writeFile(path.join(tmp, 'writes.json'), JSON.stringify([{
      match: 'Slice s1',
      files: {
        [`openspec/changes/${CHANGE}/.openspec.yaml`]: 'schema: behavior-driven\n',
        [`openspec/changes/${CHANGE}/proposal.md`]: '## Why\n',
        [`openspec/changes/${CHANGE}/specs/thread-state/spec.md`]: SPEC_MD,
        [`openspec/changes/${CHANGE}/features/thread_state.feature`]: FEATURE,
        [`openspec/changes/${CHANGE}/features/NEW_STEPS.md`]: NEW_STEPS_MD,
      },
    }]))
    process.env.FAKE_CLAUDE_WRITES_FILE = path.join(tmp, 'writes.json')

    const planner = await call(app, 'POST', `${url}/plan/run`)
    expect(planner.status).toBe(202)
    await runs.settled(planner.json.run.id)
    const draft = (await call(app, 'GET', url)).json
    expect(draft.doc.plan.status).toBe('draft')
    expect(draft.blockingDecisions).toBe(1)

    const edited = await call(app, 'PUT', `${url}/plan`, { slices: [
      { id: 's1', title: 'Engine', scope: 'The pure engine.', depends_on: [] },
      { id: 's2', title: 'Delivery', scope: 'Delivery.', depends_on: ['s1'] },
      { id: null, title: 'History', scope: 'History.', depends_on: ['s2'] },
    ] })
    expect(edited.json.plan.slices.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3'])
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('M openspec/initiatives/health-score/initiative.yaml')

    expect((await call(app, 'POST', `${url}/plan/approve`)).json.error.code).toBe('decisions_pending')
    const decisionId = draft.decisions[0].id
    const decided = await call(app, 'POST', `${url}/decisions/${decisionId}/decide`, { option: 'yes', note: 'Staging first.' })
    expect(decided.json).toMatchObject({ status: 'recorded' })
    expect(await readFile(path.join(wt, 'openspec/initiatives/health-score/decisions.md'), 'utf8')).toContain('## ')
    const approved = await call(app, 'POST', `${url}/plan/approve`)
    expect(approved.status).toBe(200)
    expect((await git(wt, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): health-score — slice plan approved (3 slices)')

    expect((await call(app, 'POST', `${url}/slices/s2/propose`, {})).json.error.code).toBe('slice_not_ready')
    const author = await call(app, 'POST', `${url}/slices/s1/propose`, { notes: 'Small.', change: CHANGE })
    expect(author.status).toBe(202)
    await runs.settled(author.json.run.id)
    const view = (await call(app, 'GET', url)).json
    expect(view.statuses).toEqual({ s1: 'proposed', s2: 'planned', s3: 'planned' })
    expect(view.blockers.s2).toBe('waiting for s1')
    const changes = (await call(app, 'GET', '/api/changes')).json.repos[0].worktrees.find((w: { path: string }) => w.path === wt)
    expect(changes.changes.find((c: { name: string }) => c.name === CHANGE)).toMatchObject({ initiative: 'health-score · s1' })

    const log = await call(app, 'GET', `${url}/runs/${author.json.run.id}/log`)
    expect(log.json.text).toContain('Wrote s1.')
    expect((await call(app, 'POST', `${url}/runs/${author.json.run.id}/resume`)).json.error.code).toBe('run_not_waiting')
    expect((await call(app, 'POST', `${url}/runs/${author.json.run.id}/stop`)).json.error.code).toBe('run_not_running')
  })

  it('adds inputs, runs research to a draft, accepts it and edits the domains', async () => {
    const { app, runs } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const form = new FormData()
    form.append('files', new File(['a'], 'notes.txt'))
    expect((await callForm(app, `${url}/inputs`, form)).json).toEqual({ files: ['notes.txt'] })
    expect((await call(app, 'POST', `${url}/inputs`, { from: 'api/features/STEPS.md' })).json).toEqual({ files: ['STEPS-2.md'] })

    process.env.FAKE_CLAUDE_REPLY = JSON.stringify({ answer: 'Found it.', patch: null, decisions: [], resolves: [], status: 'done', document: '# AR\n\n## Sources\n- https://x.example\n' })
    const research = await call(app, 'POST', `${url}/research`, { topic: 'AR ageing', questions: 'Which report?' })
    await runs.settled(research.json.run.id)
    const draft = (await call(app, 'GET', url)).json.inputs.find((i: { file: string }) => i.file === 'research-ar-ageing.md')
    expect(draft).toMatchObject({ draft: true, present: true })
    expect((await call(app, 'POST', `${url}/inputs/research-ar-ageing.md/accept`)).status).toBe(200)
    expect((await call(app, 'PUT', `${url}/research/domains`, { domains: ['developer.intuit.com'] })).json).toEqual({ domains: ['developer.intuit.com'] })
    expect((await call(app, 'PUT', `${url}/research/domains`, { domains: ['http://x'] })).json.error.code).toBe('invalid_domain')
  })

  it('serves the sandbox status by presence only and refuses runs while it is not ready', async () => {
    const { app, sandbox } = await setup()
    const { json } = await create(app)
    sandbox.statusValue = { docker: true, image: false, egressImage: true, token: false, ready: false, fixes: ['Build the sandbox images: npm run agent:build'] }
    const status = await call(app, 'GET', '/api/sandbox/status')
    expect(status.json).toEqual(sandbox.statusValue)
    expect(JSON.stringify(status.json)).not.toContain('sk-ant')
    const refused = await call(app, 'POST', `/api/initiatives/${json.worktreeId}/health-score/plan/run`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('sandbox_unavailable')
  })

  it('refuses an oversized multipart body on create and on inputs before buffering it (413 inputs_too_large)', async () => {
    const { app } = await setup()
    const created = await oversizedPost(app, '/api/initiatives')
    expect(created.status).toBe(413)
    expect(created.json.error.code).toBe('inputs_too_large')

    const { json } = await create(app)
    const oversizedInput = await oversizedPost(app, `/api/initiatives/${json.worktreeId}/health-score/inputs`)
    expect(oversizedInput.status).toBe(413)
    expect(oversizedInput.json.error.code).toBe('inputs_too_large')
  })

  it('refuses to approve the plan while a planner run of it is still running, then allows it once the planner settles', async () => {
    const { repo, app } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const dir = initiativeDir(path.join(repo, '.claude/worktrees/health-score'), 'health-score')
    const running: RunRecord = {
      id: 'r_0000ab01', kind: 'planner', slice: null, topic: null, session: 's', container: 'sr-r_0000ab01', log: '.spec-review/runs/r_0000ab01.ndjson',
      started_at: '2026-09-24T10:00:00.000Z', ended_at: null, outcome: 'running', notes: null,
    }
    await updateInitiative(dir, (d) => ({
      ...d,
      plan: { status: 'draft', approved_at: null, slices: [{ id: 's1', title: 'Engine', scope: 'The engine.', depends_on: [], change: null }] },
      runs: [running],
    }))
    const refused = await call(app, 'POST', `${url}/plan/approve`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('planner_running')

    await updateInitiative(dir, (d) => ({ ...d, runs: d.runs.map((r) => ({ ...r, outcome: 'done' as const })) }))
    const approved = await call(app, 'POST', `${url}/plan/approve`)
    expect(approved.status).toBe(200)
  })

  it('answers 409 review_invalid for a hand-edited initiative.yaml whose run log leaves its dir (final review I4)', async () => {
    const { app, repo } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const dir = initiativeDir(path.join(repo, '.claude/worktrees/health-score'), 'health-score')
    const text = await readFile(path.join(dir, 'initiative.yaml'), 'utf8')
    const evil = 'runs:\n  - id: r_0000ab01\n    kind: planner\n    session: s\n    container: c\n    log: ../../../../etc/passwd\n    started_at: x\n    outcome: done\n'
    await writeFile(path.join(dir, 'initiative.yaml'), `${text.replace(/^runs:.*$/m, '')}${evil}`)
    const res = await call(app, 'GET', `${url}/runs/r_0000ab01/log`)
    expect(res.status).toBe(409)
    expect(res.json.error).toMatchObject({ code: 'review_invalid', message: expect.stringContaining('runs.0.log') })
  })

  // Desk fixes item 1: the header ("N running") and the Runs tab follow every run start, stop and
  // resume live — each one is announced on the bus topic the UI's /api/events invalidation reads.
  it('announces every run start, stop and resume on the initiative topic', async () => {
    const { app, runs, bus, repo, sandbox } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    // Stop kills a started attempt (a Stop before the container exists is a separate race).
    const attempt = (n: number) => expect.poll(() => sandbox.runs.length).toBe(n)
    const seen: unknown[] = []
    bus.subscribe('initiative', (event) => seen.push(event.data))
    const announced = { worktreeId: json.worktreeId, name: 'health-score' }

    process.env.FAKE_CLAUDE_MODE = 'hang'
    const planner = await call(app, 'POST', `${url}/plan/run`)
    expect(planner.status).toBe(202)
    expect(seen).toEqual([announced])
    await attempt(1)
    expect((await call(app, 'POST', `${url}/runs/${planner.json.run.id}/stop`)).status).toBe(202)
    await runs.settled(planner.json.run.id)
    expect(seen).toEqual([announced, announced])
    expect((await call(app, 'GET', url)).json.doc.runs[0]).toMatchObject({ outcome: 'stopped' })

    process.env.FAKE_CLAUDE_MODE = 'answer'
    const blocking = { id: 'basis', question: 'Business or calendar age?', scope: { kind: 'change' }, options: [option('business'), option('calendar')], recommended: 'business', blocking: true }
    await writeFile(path.join(tmp, 'replies.json'), JSON.stringify([
      { match: 'Slice s1', reply: { answer: 'Need the age basis.', patch: null, decisions: [blocking], resolves: [], status: 'needs_owner', change: CHANGE } },
    ]))
    process.env.FAKE_CLAUDE_REPLIES_FILE = path.join(tmp, 'replies.json')
    const dir = initiativeDir(path.join(repo, '.claude/worktrees/health-score'), 'health-score')
    await updateInitiative(dir, (d) => ({
      ...d, plan: { status: 'approved', approved_at: '2026-09-28T10:00:00.000Z', slices: [{ id: 's1', title: 'Engine', scope: 'The engine.', depends_on: [], change: null }] },
    }))
    const author = await call(app, 'POST', `${url}/slices/s1/propose`, { change: CHANGE })
    expect(author.status).toBe(202)
    expect(seen).toHaveLength(3)
    await runs.settled(author.json.run.id)
    expect(seen).toHaveLength(4)
    const waiting = (await call(app, 'GET', url)).json
    expect(waiting.doc.runs[1]).toMatchObject({ outcome: 'needs_owner' })
    expect((await call(app, 'POST', `${url}/decisions/${waiting.decisions[0].id}/dismiss`, { reason: 'Business hours.' })).status).toBe(200)
    const count = seen.length
    process.env.FAKE_CLAUDE_MODE = 'hang'
    expect((await call(app, 'POST', `${url}/runs/${author.json.run.id}/resume`)).status).toBe(202)
    expect(seen).toHaveLength(count + 1)
    expect((await call(app, 'GET', url)).json.doc.runs[1]).toMatchObject({ outcome: 'running' })
    await attempt(3)
    await call(app, 'POST', `${url}/runs/${author.json.run.id}/stop`)
    await runs.settled(author.json.run.id)
    expect(seen).toHaveLength(count + 2)
    expect(seen.every((data) => JSON.stringify(data) === JSON.stringify(announced))).toBe(true)
  })

  it('adds and dismisses an owner decision on the initiative', async () => {
    const { app } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const added = await call(app, 'POST', `${url}/decisions`, { question: 'Ship in Q4?', blocking: true })
    expect(added.status).toBe(201)
    expect((await call(app, 'POST', `${url}/decisions/${added.json.id}/decide`, { note: ' ' })).json.error.code).toBe('note_required')
    expect((await call(app, 'POST', `${url}/decisions/${added.json.id}/dismiss`, { reason: 'Not now.' })).status).toBe(200)
    expect((await call(app, 'GET', url)).json.decisions[0]).toMatchObject({ status: 'dismissed', scope: { kind: 'change' } })
  })
})
