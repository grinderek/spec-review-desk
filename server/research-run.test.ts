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
import { resetFakeClaude } from './testing/fake-claude-path.ts'
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
  process.env.FAKE_CLAUDE_REPLIES_FILE = file
}

beforeEach(async () => {
  resetFakeClaude()
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-research-'))
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, 'calls.ndjson')
  process.env.FAKE_CLAUDE_MODE = 'answer'
})

describe('research runs', () => {
  it('searches, asks for domains, records the approved ones with the decision, reads them, and writes a draft input', async () => {
    const s = await setup()
    await replies([
      { match: 'WebFetch is now enabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com', 'docs.stripe.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Which report gives AR ageing?' })
    await s.service.settled(run.id)
    expect((await readInitiative(s.dir)).runs[0]).toMatchObject({ outcome: 'needs_owner', phase: 'search', web_fetch: false })
    const first = s.sandbox.runs[0]!
    expect(first.domains).toEqual([])
    expect(first.claude.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch'])
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
    expect(second.claude).toMatchObject({ resume: true, allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] })
    expect(second.claude.prompt).toContain('WebFetch is now enabled for: developer.intuit.com.')
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
      { match: 'WebFetch stays disabled', reply: done },
      { match: 'Topic: Intuit reports', reply: fetchDomains(['developer.intuit.com']) },
    ])
    const run = await startResearch(s.service, s.target, { topic: 'Intuit reports', questions: 'Q?' })
    await s.service.settled(run.id)
    const [decision] = (await readReview(s.dir)).decisions
    await decideInitiativeDecision(s.target, decision!.id, { option: 'search_only', note: '' }, '')
    expect((await readInitiative(s.dir)).research.domains).toEqual([])
    await resumeResearch(s.service, s.target, run.id)
    await s.service.settled(run.id)
    expect(s.sandbox.runs[1]!.claude.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch'])
    expect(s.sandbox.runs[1]!.domains).toEqual([])
    expect((await readInitiative(s.dir)).inputs.at(-1)).toMatchObject({ draft: true, source: { domains: [] } })
  })

  it('names research files after the topic without clobbering', () => {
    expect(researchFileName('Intuit reports', [])).toBe('research-intuit-reports.md')
    expect(researchFileName('Intuit reports', ['research-intuit-reports.md', 'research-intuit-reports-2.md'])).toBe('research-intuit-reports-3.md')
    expect(researchFileName('???', [])).toBe('research-topic.md')
  })
})
