import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from './events.ts'
import { git } from './git.ts'
import { decideInitiativeDecision } from './initiative-decisions.ts'
import { readInitiative } from './initiative-store.ts'
import { researchFileName, resumeResearch, startResearch } from './research-run.ts'
import { readReview } from './review-store.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService } from './run-service.ts'
import { BROWSER_TOOLS } from './sandbox-args.ts'
import { resetFakeCodex } from './testing/fake-codex-path.ts'
import { FakeSandbox } from './testing/fake-sandbox.ts'
import { testConfig } from './testing/http.ts'
import { makeInitiative } from './testing/initiative.ts'
import { makeRepo } from './testing/repo.ts'

const option = (id: string) => ({ id, label: id, consequence: `${id}.` })
const fetchDomains = (domains: string[]) => ({
  answer: 'I need two pages.',
  patch: null,
  decisions: [{
    id: 'fetch-domains', question: 'developer.intuit.com — report API — "ProfitAndLoss"\ndocs.stripe.com — payouts', scope: { kind: 'change' },
    options: [option('allow_all'), option('allow_some'), option('search_only')], recommended: 'allow_all', blocking: true, requested_domains: domains,
  }],
  resolves: [],
  status: 'needs_owner',
  document: '',
})
const DOCUMENT = '# Intuit reports\n\nUse ProfitAndLoss.\n\n## Sources\n- https://developer.intuit.com/reports\n'
const done = { answer: 'Done.', patch: null, decisions: [], resolves: [], status: 'done', document: DOCUMENT }
let tmp = ''

async function setup(domains: string[] = []) {
  const { repo } = await makeRepo()
  const { wt, ini, dir } = await makeInitiative(repo, { research: { domains } })
  const sandbox = new FakeSandbox()
  const service = new InitiativeRunService({ config: testConfig(repo), bus: new EventBus(), sandbox, finishers: FINISHERS })
  return { repo, wt, ini, dir, sandbox, service, target: { wt, ini } }
}
async function replies(entries: { match: string; reply: unknown }[]): Promise<void> {
  const file = path.join(tmp, 'replies.json')
  await writeFile(file, JSON.stringify(entries))
  process.env.FAKE_CODEX_REPLIES_FILE = file
}

beforeEach(async () => {
  resetFakeCodex()
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-research-'))
  process.env.FAKE_CODEX_LOG = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CODEX_MODE = 'answer'
})

describe('research runs', () => {
  it('searches, asks for domains, records the approved ones with the decision, reads them, and writes a draft input', async () => {
    const s = await setup()
    await replies([
      { match: 'desk.read_web_page is now enabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com', 'docs.stripe.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Which report gives AR ageing?' })
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', phase: 'search', web_fetch: false })
    const first = s.sandbox.runs[0]!
    expect(first.domains).toEqual([])
    expect(first.browser).toBe(false)
    expect(first.codex.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch'])
    const [decision] = (await readReview(s.dir)).decisions
    expect(decision).toMatchObject({ agent_id: 'fetch-domains', requested_domains: ['developer.intuit.com', 'docs.stripe.com'], blocking: true })
    await expect(resumeResearch(s.service, s.target, run.id)).rejects.toMatchObject({ code: 'decisions_pending' })

    await expect(decideInitiativeDecision(s.target, decision!.id, { option: 'allow_some', note: 'none' }, 'T: t')).rejects.toMatchObject({ code: 'domains_required' })
    const { commit } = await decideInitiativeDecision(s.target, decision!.id, { option: 'allow_some', note: 'Only developer.intuit.com' }, 'Co-Authored-By: T <t@example.com>')
    expect((await git(s.repo, ['show', '--name-only', '--format=', commit])).trim().split('\n').sort()).toEqual([
      'openspec/initiatives/hs/decisions.md', 'openspec/initiatives/hs/initiative.yaml', 'openspec/initiatives/hs/review.yaml',
    ])
    expect((await readInitiative(s.dir)).research.domains).toEqual(['developer.intuit.com'])

    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    const second = s.sandbox.runs[1]!
    expect(second.domains).toEqual(['developer.intuit.com'])
    expect(second.browser).toBe(true)
    expect(second.codex).toMatchObject({ resume: true, allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', ...BROWSER_TOOLS] })
    expect(second.codex.prompt).toContain('desk.read_web_page is now enabled for: developer.intuit.com.')
    expect(second.codex.prompt).toContain('The browser (the browser MCP tools) reaches the same hosts')
    const doc = await readInitiative(s.dir)
    expect(doc.runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
    expect(doc.inputs.at(-1)).toMatchObject({
      file: 'research-intuit-reports.md', draft: true, source: { kind: 'research', run: run.id, domains: ['developer.intuit.com'] },
    })
    expect(await readFile(path.join(s.dir, 'inputs/research-intuit-reports.md'), 'utf8')).toBe(DOCUMENT)
  })

  it('continues straight into the read phase when every requested domain is already allowed (ruling 2)', async () => {
    const s = await setup(['developer.intuit.com'])
    await replies([
      { match: 'already allowed', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['Developer.Intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    expect((await readReview(s.dir)).decisions).toEqual([])
    expect(s.sandbox.runs.map((r) => r.domains)).toEqual([[], ['developer.intuit.com']])
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
  })

  it('resumes without WebFetch when the owner chooses search only', async () => {
    const s = await setup()
    await replies([
      { match: 'desk.read_web_page stays disabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [decision] = (await readReview(s.dir)).decisions
    await decideInitiativeDecision(s.target, decision!.id, { option: 'search_only', note: '' }, '')
    expect((await readInitiative(s.dir)).research.domains).toEqual([])
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs[1]!.codex.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch'])
    expect(s.sandbox.runs[1]!.domains).toEqual([])
    expect(s.sandbox.runs[1]!.browser).toBe(false)
    expect((await readInitiative(s.dir)).inputs.at(-1)).toMatchObject({ draft: true, source: { domains: [] } })
  })

  it('asks again for the hosts a JavaScript page loads from, and reads on with the browser once they are approved', async () => {
    const s = await setup(['developer.intuit.com'])
    await replies([
      { match: 'The owner answered', reply: done },
      { match: 'already allowed', reply: fetchDomains(['uxfabric.intuitcdn.net', 'developer.intuit.com']) },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', phase: 'read', web_fetch: true })
    const [decision] = (await readReview(s.dir)).decisions
    expect(decision).toMatchObject({ agent_id: 'fetch-domains', requested_domains: ['uxfabric.intuitcdn.net', 'developer.intuit.com'] })
    await decideInitiativeDecision(s.target, decision!.id, { option: 'allow_all', note: '' }, '')
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs.map((r) => [r.browser, r.domains])).toEqual([
      [false, []],
      [true, ['developer.intuit.com']],
      [true, ['developer.intuit.com', 'uxfabric.intuitcdn.net']],
    ])
    expect(s.sandbox.runs[2]!.codex.prompt).toContain('desk.read_web_page is now enabled for: developer.intuit.com, uxfabric.intuitcdn.net.')
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
  })

  // Controller ruling 1: the browser image gates only a read phase that reads the web.
  const NO_BROWSER = { browserImage: false, browserFix: 'Build the research browser image: npm run agent:build' }

  it('searches without the browser image but refuses Resume into a reading phase until it is built', async () => {
    const s = await setup()
    s.sandbox.statusValue = { ...s.sandbox.statusValue, ...NO_BROWSER }
    await replies([
      { match: 'desk.read_web_page is now enabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [decision] = (await readReview(s.dir)).decisions
    await decideInitiativeDecision(s.target, decision!.id, { option: 'allow_all', note: '' }, '')
    await expect(resumeResearch(s.service, s.target, run.id)).rejects.toMatchObject({
      status: 409, code: 'browser_unavailable', message: expect.stringContaining('npm run agent:build'),
    })
    expect(s.sandbox.runs).toHaveLength(1)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', phase: 'search' })

    s.sandbox.statusValue = { ...s.sandbox.statusValue, browserImage: true, browserFix: null }
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs.map((r) => r.browser)).toEqual([false, true])
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
  })

  it('resumes search-only without the browser image', async () => {
    const s = await setup()
    s.sandbox.statusValue = { ...s.sandbox.statusValue, ...NO_BROWSER }
    await replies([
      { match: 'desk.read_web_page stays disabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [decision] = (await readReview(s.dir)).decisions
    await decideInitiativeDecision(s.target, decision!.id, { option: 'search_only', note: '' }, '')
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs.map((r) => r.browser)).toEqual([false, false])
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', web_fetch: false })
  })

  it('does not continue into the read phase on its own without the browser image: the run waits for the owner', async () => {
    const s = await setup(['developer.intuit.com'])
    s.sandbox.statusValue = { ...s.sandbox.statusValue, ...NO_BROWSER }
    await replies([
      { match: 'already allowed', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    expect(s.sandbox.runs).toHaveLength(1)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({
      outcome: 'needs_owner', phase: 'read', web_fetch: true, notes: expect.stringContaining('npm run agent:build'),
    })
    await expect(resumeResearch(s.service, s.target, run.id)).rejects.toMatchObject({ code: 'browser_unavailable' })

    s.sandbox.statusValue = { ...s.sandbox.statusValue, browserImage: true, browserFix: null }
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    const second = s.sandbox.runs[1]!
    expect(second).toMatchObject({ browser: true, domains: ['developer.intuit.com'] })
    expect(second.codex).toMatchObject({ resume: true, allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', ...BROWSER_TOOLS] })
    expect(second.codex.prompt).toContain('All the domains you asked for are already allowed. desk.read_web_page is now enabled for: developer.intuit.com.')
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
  })

  it('stops reading when the owner answers the asset-host decision with search only (review fix 3)', async () => {
    const s = await setup(['developer.intuit.com'])
    await replies([
      { match: 'desk.read_web_page and the browser are now off', reply: done },
      { match: 'already allowed', reply: fetchDomains(['uxfabric.intuitcdn.net']) },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [decision] = (await readReview(s.dir)).decisions
    expect(decision).toMatchObject({ requested_domains: ['uxfabric.intuitcdn.net'] })
    await decideInitiativeDecision(s.target, decision!.id, { option: 'search_only', note: '' }, '')
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    const third = s.sandbox.runs[2]!
    expect(third).toMatchObject({ browser: false, domains: [] })
    expect(third.codex.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch'])
    expect(third.codex.prompt).toContain(
      'The owner chose search only: desk.read_web_page and the browser are now off. Write the document from what you have already read and the search results',
    )
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: false })
    // Re-review (b): the draft records the domains its reading phase used, not [] because reading stopped.
    expect((await readInitiative(s.dir)).inputs.at(-1)).toMatchObject({ draft: true, source: { kind: 'research', domains: ['developer.intuit.com'] } })
  })

  it('never turns reading back on by itself after the owner chose search only (re-review a)', async () => {
    const s = await setup(['developer.intuit.com'])
    await replies([
      { match: 'already allowed', reply: fetchDomains(['uxfabric.intuitcdn.net']) },
      { match: 'now off', reply: fetchDomains(['developer.intuit.com']) },
      { match: 'desk.read_web_page is now enabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [assets] = (await readReview(s.dir)).decisions
    await decideInitiativeDecision(s.target, assets!.id, { option: 'search_only', note: '' }, '')
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    // The agent asks again for a host that is already approved: the owner decides, not the Desk.
    expect(s.sandbox.runs).toHaveLength(3)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', web_fetch: false })
    const again = (await readReview(s.dir)).decisions[1]
    expect(again).toMatchObject({ agent_id: 'fetch-domains', status: 'open', requested_domains: ['developer.intuit.com'] })

    await decideInitiativeDecision(s.target, again!.id, { option: 'allow_all', note: '' }, '')
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs.map((r) => r.browser)).toEqual([false, true, false, true])
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'done', phase: 'read', web_fetch: true })
    expect((await readInitiative(s.dir)).inputs.at(-1)).toMatchObject({ source: { domains: ['developer.intuit.com'] } })
  })

  it('names research files after the topic without clobbering', () => {
    expect(researchFileName('Intuit reports', [])).toBe('research-intuit-reports.md')
    expect(researchFileName('Intuit reports', ['research-intuit-reports.md', 'research-intuit-reports-2.md'])).toBe('research-intuit-reports-3.md')
    expect(researchFileName('???', [])).toBe('research-topic.md')
  })
})
