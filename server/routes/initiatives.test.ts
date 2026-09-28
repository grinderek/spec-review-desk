import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

// A GET whose raw Response is inspected (content type, disposition, bytes).
function rawGet(app: Awaited<ReturnType<typeof setup>>['app'], url: string): Promise<Response> {
  return Promise.resolve(app.request(`http://127.0.0.1:${TEST_PORT}${url}`, {
    headers: { host: `127.0.0.1:${TEST_PORT}`, cookie: `sr_token=${TEST_TOKEN}` },
  }))
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

  // Desk fixes item 3: what New feature sends arrives — a multipart brief comes with CRLF line
  // breaks (the browser normalizes them so) and is stored with LF; every "Add from repo" line is
  // listed, and a line that cannot be read fails the create instead of vanishing.
  it('creates with the brief as written and every repo line listed, or fails naming the line', async () => {
    const { app, repo } = await setup()
    const form = new FormData()
    for (const [k, v] of Object.entries({ name: 'crlf-brief', repo: 'api', where: 'new', base: 'main', title: 'CRLF' })) form.set(k, v)
    form.set('brief', '# What\r\n\r\nScore the day.\r\n')
    form.set('fromRepo', 'api/features/STEPS.md\r\n\r\n  api/openspec/changes/add-thread-state/proposal.md  \r\n')
    const created = await callForm(app, '/api/initiatives', form)
    expect(created.status).toBe(201)
    const view = (await call(app, 'GET', `/api/initiatives/${created.json.worktreeId}/crlf-brief`)).json
    expect(view.brief).toBe('# What\n\nScore the day.\n')
    expect(view.inputs.map((i: { file: string; source: { path: string } }) => [i.file, i.source.path])).toEqual([
      ['STEPS.md', 'api/features/STEPS.md'],
      ['proposal.md', 'api/openspec/changes/add-thread-state/proposal.md'],
    ])

    const missing = new FormData()
    for (const [k, v] of Object.entries({ name: 'missing-line', repo: 'api', where: 'new', base: 'main', title: 'Missing' })) missing.set(k, v)
    missing.set('fromRepo', 'api/features/STEPS.md\napi/doc/no-such.md')
    const refused = await callForm(app, '/api/initiatives', missing)
    expect(refused.status).toBe(404)
    expect(refused.json.error).toMatchObject({ code: 'unknown_file', message: expect.stringContaining('api/doc/no-such.md') })
    expect((await git(repo, ['branch', '--list', 'plan/missing-line'])).trim()).toBe('')

    // A list sent as a file part is refused, never dropped.
    const asFile = new FormData()
    for (const [k, v] of Object.entries({ name: 'file-list', repo: 'api', where: 'new', base: 'main', title: 'File list' })) asFile.set(k, v)
    asFile.set('fromRepo', new File(['api/features/STEPS.md'], 'list.txt'))
    const bad = await callForm(app, '/api/initiatives', asFile)
    expect(bad.status).toBe(422)
    expect(bad.json.error.code).toBe('invalid_body')
    expect((await git(repo, ['branch', '--list', 'plan/file-list'])).trim()).toBe('')
  })

  // Desk fixes item 4: the owner reads an input (or a research draft before Accept) in the Desk.
  it('serves a listed input — text as text, a PDF or an image inline with its type — and nothing else', async () => {
    const { app, repo } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const dir = initiativeDir(path.join(repo, '.claude/worktrees/health-score'), 'health-score')
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff])
    const form = new FormData()
    form.append('files', new File([pdf], 'score spec.pdf', { type: 'application/pdf' }))
    form.append('files', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png'))
    form.append('files', new File(['{"a":1}'], 'data.json'))
    expect((await callForm(app, `${url}/inputs`, form)).json.files).toEqual(['score-spec.pdf', 'shot.png', 'data.json'])

    const md = await rawGet(app, `${url}/inputs/spec.md`)
    expect(md.status).toBe(200)
    expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(md.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await md.text()).toBe('# Spec\n')
    const data = await rawGet(app, `${url}/inputs/data.json`)
    expect(data.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await data.text()).toBe('{"a":1}')

    const served = await rawGet(app, `${url}/inputs/score-spec.pdf`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('application/pdf')
    expect(served.headers.get('content-disposition')).toBe('inline; filename="score-spec.pdf"')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(pdf)
    const png = await rawGet(app, `${url}/inputs/shot.png`)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('content-disposition')).toBe('inline; filename="shot.png"')

    const unknown = await rawGet(app, `${url}/inputs/nope.md`)
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).error.code).toBe('unknown_input')
    for (const evil of ['..%2Finitiative.yaml', '%2E%2E', '..%2F..%2F..%2F..%2Fconfig.yaml', 'initiative.yaml', '.hidden.md']) {
      const refused = await rawGet(app, `${url}/inputs/${evil}`)
      expect(refused.status, evil).toBeGreaterThanOrEqual(400)
      expect(refused.status, evil).toBeLessThan(500)
      expect(await refused.text(), evil).not.toContain('version: 1')
    }

    // A listed input that is a symlink out of inputs/ is refused, even when its name is valid.
    await symlink(path.join(dir, 'initiative.yaml'), path.join(dir, 'inputs', 'leak.md'))
    await updateInitiative(dir, (d) => ({ ...d, inputs: [...d.inputs, { file: 'leak.md', bytes: 1, source: { kind: 'upload' }, added_at: 'x', draft: false }] }))
    const leak = await rawGet(app, `${url}/inputs/leak.md`)
    expect(leak.status).toBe(409)
    expect(await leak.text()).not.toContain('version: 1')
    // A listed input whose file is gone answers 404 input_missing.
    await rm(path.join(dir, 'inputs', 'shot.png'))
    expect((await (await rawGet(app, `${url}/inputs/shot.png`)).json()).error.code).toBe('input_missing')
  })

  // Desk fixes item 2: the brief is editable after creation.
  it('edits the brief: writes brief.md and commits it like the other initiative commits', async () => {
    const { app, repo, bus } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const wt = path.join(repo, '.claude/worktrees/health-score')
    const seen: unknown[] = []
    bus.subscribe('initiative', (event) => seen.push(event.data))

    const saved = await call(app, 'PUT', `${url}/brief`, { brief: '# What\n\nScore the founder day, edited.' })
    expect(saved.status).toBe(200)
    expect(saved.json).toEqual({ brief: '# What\n\nScore the founder day, edited.\n', commit: expect.stringMatching(/^[0-9a-f]{7,}$/) })
    expect(await readFile(path.join(wt, 'openspec/initiatives/health-score/brief.md'), 'utf8')).toBe('# What\n\nScore the founder day, edited.\n')
    expect(await git(wt, ['log', '-1', '--format=%B'])).toBe('docs(openspec): health-score — brief\n\nCo-Authored-By: Test <test@example.com>\n\n')
    expect((await git(wt, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe('openspec/initiatives/health-score/brief.md')
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
    expect((await call(app, 'GET', url)).json.brief).toBe('# What\n\nScore the founder day, edited.\n')
    expect(seen).toEqual([{ worktreeId: json.worktreeId, name: 'health-score' }])

    // Saving the same text again changes nothing: no empty commit, no error.
    const head = (await git(wt, ['rev-parse', 'HEAD'])).trim()
    expect((await call(app, 'PUT', `${url}/brief`, { brief: '# What\n\nScore the founder day, edited.\n' })).json).toMatchObject({ commit: null })
    expect((await git(wt, ['rev-parse', 'HEAD'])).trim()).toBe(head)

    for (const body of [{}, { brief: 7 }, { brief: 'x'.repeat(20_001) }]) {
      const refused = await call(app, 'PUT', `${url}/brief`, body)
      expect(refused.status).toBe(422)
      expect(refused.json.error.code).toBe('invalid_body')
    }
    expect((await call(app, 'PUT', `/api/initiatives/${json.worktreeId}/no-such/brief`, { brief: 'x' })).json.error.code).toBe('unknown_initiative')
    // The limit holds for the stored text: 20 000 characters without a final newline would be
    // stored as 20 001 and refused on the next save.
    expect((await call(app, 'PUT', `${url}/brief`, { brief: 'x'.repeat(20_000) })).status).toBe(422)
    expect((await call(app, 'PUT', `${url}/brief`, { brief: `${'x'.repeat(19_999)}\n` })).status).toBe(200)
  })

  // Review fix 1: a brief whose commit failed is committed by the next save of the same text
  // (it used to count as "unchanged" — commit: null — and stay uncommitted for good).
  it('commits a brief whose earlier commit failed when it is saved again', async () => {
    const { app, repo } = await setup()
    const { json } = await create(app)
    const url = `/api/initiatives/${json.worktreeId}/health-score`
    const wt = path.join(repo, '.claude/worktrees/health-score')
    const hooks = path.join(tmp, 'hooks')
    await mkdir(hooks, { recursive: true })
    await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await git(repo, ['config', 'core.hooksPath', hooks])
    const failed = await call(app, 'PUT', `${url}/brief`, { brief: 'Edited once.' })
    expect(failed.status).toBe(500)
    expect(failed.json.error.code).toBe('command_failed')
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('M openspec/initiatives/health-score/brief.md')

    await git(repo, ['config', '--unset', 'core.hooksPath'])
    const retried = await call(app, 'PUT', `${url}/brief`, { brief: 'Edited once.' })
    expect(retried.status).toBe(200)
    expect(retried.json.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
    expect((await git(wt, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): health-score — brief')
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
