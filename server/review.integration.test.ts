import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { emptyReview, readReview, readReviewEvents, REVIEW_EVENTS_FILE, REVIEW_FILE, ReviewSchema, updateReview, type Entry } from './review-store.ts'
import { FEATURE, NEW_STEPS_MD, SPEC_MD, STEPS_MD } from './testing/fixtures.ts'
import { sh, writeFiles } from './testing/repo.ts'
import { ReviewWorld } from './testing/review-world.ts'

let world: ReviewWorld
beforeEach(async () => {
  world = await ReviewWorld.create()
  await world.given('ScenarioDiscovered', {})
  await world.ready()
})
afterEach(async () => { await world?.close() })
const file = (name: string) => path.join(world.dir, name)
const entry = (hash = String(world.vars.hash)): Entry => ({ status: 'approved', text_hash: hash, approved_commit: String(world.vars.head), at: String(world.vars.at) })
async function view() { const response = await world.command('ReadChange', {}); expect(response.status).toBe(200); return response.body }
async function approvedReview() {
  await world.given('PhraseProposed', {})
  return ReviewSchema.parse({ ...emptyReview(), scenarios: { [String(world.vars.key)]: entry() },
    phrases: { [String(world.vars.phrase)]: entry(String(world.vars.phraseHash)) }, approved_at: world.vars.at, approved_commit: world.vars.head })
}

// Exercise real disk, HTTP and Git boundaries. Product rules live in features/, not here.
describe('review storage compatibility', () => {
  it('exposes defaults without a review file', async () => {
    const result = await view()
    expect(result.review).toEqual(emptyReview())
    expect(result.features[0].scenarios[0].effective).toEqual({ status: 'pending', changedSinceApproval: false, approvedCommit: null })
  })

  it('recovers all approval sections and escaped keys while keeping the journal authoritative', async () => {
    const expected = await approvedReview()
    const escaped = 'features/quoted: #1 — ünïcode.feature::It\'s "quoted"'
    expected.scenarios[escaped] = entry()
    await updateReview(world.dir, () => expected)
    await writeFile(file(REVIEW_FILE), stringify({ ...expected, scenarios: {}, phrases: {}, approved_at: null, approved_commit: null }))
    expect((await view()).review).toEqual(expected)
    await rm(file(REVIEW_FILE))
    expect((await view()).review).toEqual(expected)
    expect((await view()).features[0].scenarios[0].effective.status).toBe('approved')
  })

  it.each([false, true])('imports legacy approvals with scenario-only history=%s', async (journalled) => {
    const previous = await approvedReview()
    await writeFile(file(REVIEW_FILE), stringify(previous))
    if (journalled) await writeFile(file(REVIEW_EVENTS_FILE), JSON.stringify({ version: 1, type: 'ScenarioApproved', key: world.vars.key, entry: entry() }) + '\n')
    const before = await readReviewEvents(world.dir)
    expect((await world.command('ApprovePhrase', { key: world.vars.phrase })).status).toBe(200)
    const actual = (await view()).review
    expect(actual.scenarios).toEqual(previous.scenarios)
    expect(actual.phrases[String(world.vars.phrase)].text_hash).toBe(world.vars.phraseHash)
    expect(actual.approved_at).toBe(previous.approved_at)
    expect(actual.approved_commit).toBe(previous.approved_commit)
    expect((await readReviewEvents(world.dir)).slice(before.length).map(e => e.type)).toEqual(['PhraseApproved'])
    await rm(file(REVIEW_FILE))
    expect((await view()).review).toEqual(actual)
  })

  it('preserves external session edits, discussion payloads and both decision source formats', async () => {
    const expected = await approvedReview()
    expected.threads = ReviewSchema.parse({ version: 1, threads: [{ id: 't_fixture', anchor: 'change', ref: '', status: 'answered', messages: [
      { role: 'agent', at: world.vars.at, text: 'Two readings.', patch: { diff: 'patch-data', state: 'applied', commit: 'abc1234', files: ['features/x.feature'] },
        decision_ids: ['d_thread'], resolves: [], invalid: { issues: ['invalid field'], raw: '{}' } },
    ] }] }).threads
    expected.decisions = ReviewSchema.parse({ version: 1, decisions: [
      { id: 'd_thread', source: { kind: 'thread', id: 't_fixture' }, scope: { kind: 'scenario', key: 'escaped: #1 — ü' }, requested_domains: [], created_at: world.vars.at },
      { id: 'd_research', source: { kind: 'run', run: 'r_1', agent: 'research' }, scope: { kind: 'change' }, requested_domains: ['docs.stripe.com'], created_at: world.vars.at },
    ].map(d => ({ ...d, question: 'Owner choice?', blocking: true, status: 'open', options: [{ id: 'yes', label: 'Yes', consequence: 'Ship.' }] })) }).decisions
    await updateReview(world.dir, () => expected)
    expected.agent_session = 'external-session'
    await writeFile(file(REVIEW_FILE), stringify(expected))
    await world.command('ApprovePhrase', { key: world.vars.phrase })
    const actual = (await view()).review
    expect(actual.agent_session).toBe(expected.agent_session)
    expect(actual.threads).toEqual(expected.threads)
    expect(actual.decisions).toEqual(expected.decisions)
  })

  it('serializes concurrent writes and replays both after projection loss', async () => {
    await Promise.all(['first', 'second'].map(key => updateReview(world.dir, doc => ({ ...doc, scenarios: { ...doc.scenarios, [key]: entry() } }))))
    await rm(file(REVIEW_FILE))
    expect((await view()).review.scenarios).toEqual({ first: entry(), second: entry() })
    expect((await readReviewEvents(world.dir)).map(e => e.type)).toEqual(['ScenarioApproved', 'ScenarioApproved'])
  })

  it.each([
    [REVIEW_FILE, 'version: 7'], [REVIEW_FILE, 'version: [unclosed'], [REVIEW_EVENTS_FILE, '{broken\n'],
  ])('blocks corrupt state in %s (%s)', async (name, source) => {
    await writeFile(file(name), source)
    await expect(readReview(world.dir)).rejects.toThrow()
    const result = await view()
    expect(result.reviewErrors).not.toBeNull()
    expect(result.readiness.ready).toBe(false)
    expect(await readFile(file(name), 'utf8')).toBe(source)
  })

  it('commits the projection and history with the approval parent recorded', async () => {
    await updateReview(world.dir, doc => ({ ...doc, scenarios: { [String(world.vars.key)]: entry() } }))
    const response = await world.command('RecordChangeApproval', {})
    expect(response.status).toBe(200)
    expect(await world.commitContract()).toEqual({ head: response.body.commit, parent: world.vars.head,
      message: 'docs(openspec): subject — owner approval', files: ['openspec/changes/subject/review.events.jsonl', 'openspec/changes/subject/review.yaml'] })
    expect((await readReview(world.dir)).approved_commit).toBe(world.vars.head)
  })
})

describe('review HTTP validation', () => {
  it.each([
    ['scenarios/approve', { key: 'missing' }, 404, 'unknown_scenario'],
    ['phrases/approve', { key: 'missing' }, 404, 'unknown_phrase'],
    ['scenarios/request-changes', { key: 'missing', reason: 'Explain.' }, 404, 'unknown_scenario'],
    ['scenarios/request-changes', { key: 'missing', reason: ' ' }, 400, 'invalid_body'],
    ['orphans/reattach', { section: 'scenarios', key: 'old', to: 'missing' }, 404, 'unknown_target'],
    ['orphans/reattach', { section: 'scenarios', key: 'missing', to: '$key' }, 404, 'unknown_entry'],
  ])('rejects %s with %s (%s %s) without writing events', async (operation, payload, status, code) => {
    await updateReview(world.dir, doc => ({ ...doc, scenarios: { old: entry('obsolete') } }))
    const before = await readFile(file(REVIEW_EVENTS_FILE), 'utf8')
    const response = await world.command('HttpRequest', { method: 'POST', path: `${world.vars.change}/${operation}`, body: world.resolve(payload) })
    expect(response).toMatchObject({ status, body: { error: { code } } })
    expect(await readFile(file(REVIEW_EVENTS_FILE), 'utf8')).toBe(before)
  })

  it.each(['scenarios/approve', 'scenarios/revoke', 'scenarios/request-changes', 'phrases/approve', 'phrases/revoke', 'approval', 'orphans/drop', 'orphans/reattach'])('rejects archived %s before mutation', async (operation) => {
    const archive = path.join(world.repo, 'openspec/changes/archive/subject')
    await mkdir(path.dirname(archive), { recursive: true })
    await rename(world.dir, archive)
    await world.ready()
    const response = await world.command('HttpRequest', { method: 'POST', path: `${world.vars.change}/${operation}`, body: { key: world.vars.key, reason: 'Explain.', section: 'scenarios', to: 'missing' } })
    expect(response).toMatchObject({ status: 409, body: { error: { code: 'archived' } } })
    expect(await readReviewEvents(archive)).toEqual([])
  })
})

describe('contract and view integration', () => {
  it.each(['two commands', 'unknown field', 'duplicate YAML key', 'alias', 'duplicate id'])('reports %s through discovery', async (kind) => {
    const scenario = { id: 'subject', scenario: 'Subject contract', given: [], when: { Inspect: {} }, then: { events: [], response: { status: 200 } } }
    let source = stringify({ version: 1, feature: 'Invalid', scenarios: [scenario] })
    if (kind === 'two commands') source = source.replace('Inspect: {}', 'Inspect: {}\n      Extra: {}')
    if (kind === 'unknown field') source += 'typo: ignored\n'
    if (kind === 'duplicate YAML key') source = 'version: 1\n' + source
    if (kind === 'alias') source = source.replace('given: []', 'given: [{ ScenarioDiscovered: &payload {} }]').replace('Inspect: {}', 'Inspect: *payload')
    if (kind === 'duplicate id') source = stringify({ version: 1, feature: 'Invalid', scenarios: [scenario, structuredClone(scenario)] })
    await writeFile(file('features/subject.desk.yaml'), source)
    const result = await view()
    expect(result.features).toEqual([])
    expect(result.errors).toEqual([expect.objectContaining({ file: 'features/subject.desk.yaml' })])
    expect(result.readiness.ready).toBe(false)
  })

  it.each([
    [[], '1 scenario without a spec line'],
    [['Subject contract', 'Missing'], '1 spec title without a scenario'],
    [['Subject contract', 'Subject contract'], '1 duplicate title'],
  ])('blocks inconsistent spec titles %s', async (titles, reason) => {
    await updateReview(world.dir, doc => ({ ...doc, scenarios: { [String(world.vars.key)]: entry() } }))
    await writeFile(file('specs/subject/spec.md'), (titles as string[]).map(t => `#### Scenario: ${t}\n`).join('\n'))
    const result = await view()
    expect(result.joinKey.ok).toBe(false)
    expect(result.readiness.reasons.join('; ')).toContain(reason)
  })

  it('blocks empty and uncatalogued sources, and keeps valid files visible beside parse errors', async () => {
    const source = file('features/subject.desk.yaml')
    const original = await readFile(source, 'utf8')
    await rm(source)
    await writeFile(file('specs/subject/spec.md'), '')
    expect((await view()).readiness.reasons).toContain('no scenarios')
    await writeFile(file('features/legacy.feature'), 'Feature: Subject\n  Scenario: Subject contract\n    Given a missing phrase\n    When a command arrives\n    Then something happened\n')
    expect((await view()).readiness.reasons).toContain('3 uncatalogued steps')
    await rm(file('features/legacy.feature'))
    await writeFile(source, original)
    await writeFile(file('features/broken.feature'), 'Feature: a\n  Scenario: s\n    Given x:\n      | a | b |\n      | 1 |\n')
    const result = await view()
    expect(result.features[0].scenarios[0].title).toBe('Subject contract')
    expect(result.errors[0].file).toBe('features/broken.feature')
    expect(result.readiness.reasons).toContain('1 file failed to parse')
  })

  it('renders legacy phrases, example rows and introducing commits', async () => {
    await rm(file('features/subject.desk.yaml'))
    await writeFiles(world.repo, { 'features/STEPS.md': STEPS_MD, 'openspec/changes/subject/features/thread_state.feature': FEATURE,
      'openspec/changes/subject/features/NEW_STEPS.md': NEW_STEPS_MD, 'openspec/changes/subject/specs/subject/spec.md': SPEC_MD })
    sh(world.repo, 'git', ['add', '-A']); sh(world.repo, 'git', ['commit', '-q', '-m', 'legacy source'])
    const result = await view()
    expect(result.features[0].scenarios).toHaveLength(2)
    expect(result.features[0].scenarios[0].decisions[0].commit).toBe(sh(world.repo, 'git', ['rev-parse', '--short', 'HEAD']).trim())
    expect(result.features[0].scenarios[1].kind).toBe('Scenario Outline')
    expect(result.phrases.map((p: any) => [p.kind, p.usedBy])).toEqual([['extension', 0], ['phrase', 2], ['phrase', 1]])
    expect(result.joinKey.ok).toBe(true)
  })

  it('exposes summary obligations, orphan decisions and the decision log', async () => {
    await world.given('DecisionRaised', { id: 'd_1', scope: { kind: 'scenario', key: world.vars.key } })
    await world.given('DecisionRaised', { id: 'd_2', scope: { kind: 'scenario', key: 'gone' }, blocking: false })
    await writeFile(file('decisions.md'), '# Owner decisions\n\n## 2026-10-01 — Ship?\nDecision: —\nNote: Yes.\nSource: owner · d_3\n')
    const summary = await world.command('ReadChangeSummary', {})
    expect(summary.body.repos[0].worktrees[0].changes[0]).toMatchObject({ total: 1, approved: 0, phrasesTotal: 0, openThreads: 0, openDecisions: 2, blockingDecisions: 1, ready: false })
    const result = await view()
    expect(result.decisions.map((d: any) => [d.id, d.orphaned])).toEqual([['d_1', false], ['d_2', true]])
    expect(result.decisionLog).toEqual([expect.objectContaining({ question: 'Ship?', note: 'Yes.', id: 'd_3' })])
    expect(result.docs.decisions).toContain('Ship?')
  })
})
