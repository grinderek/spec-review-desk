import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { authorPrompt, plannerPrompt, researchPrompt, researchResumeClosing } from './initiative-prompt.ts'
import { parseRunReply, REPLY_SCHEMA_ARGS, validateRunReply } from './initiative-protocol.ts'
import { emptyInitiative } from './initiative-store.ts'

const base = { answer: 'Done.', patch: null, decisions: [], resolves: [], status: 'done' }
const option = (id: string) => ({ id, label: id, consequence: `${id}.` })
const fetchDomains = (over: Record<string, unknown> = {}) => ({
  id: 'fetch-domains',
  question: 'May I read these pages?\ndeveloper.intuit.com — report API — "ProfitAndLoss report"',
  scope: { kind: 'change' },
  options: [option('allow_all'), option('allow_some'), option('search_only')],
  recommended: 'allow_all',
  blocking: true,
  requested_domains: ['developer.intuit.com'],
  ...over,
})
const issuesOf = (kind: 'planner' | 'author' | 'research', raw: unknown, ctx = { change: 'add-hs-email' }): string[] => {
  const parsed = parseRunReply(kind, raw)
  return parsed.reply ? validateRunReply(kind, parsed.reply, ctx) : parsed.issues
}

describe('reply schemas (sub-project A reply + one field per agent)', () => {
  it('adds slices, change or document to the closed A schema', () => {
    const planner = JSON.parse(REPLY_SCHEMA_ARGS.planner) as { required: string[]; additionalProperties: boolean; properties: Record<string, any> }
    expect(planner.additionalProperties).toBe(false)
    expect(planner.required).toContain('slices')
    expect(planner.properties.slices.maxItems).toBe(12)
    expect((JSON.parse(REPLY_SCHEMA_ARGS.author) as { required: string[] }).required).toContain('change')
    const research = JSON.parse(REPLY_SCHEMA_ARGS.research) as { required: string[]; properties: Record<string, any> }
    expect(research.required).toContain('document')
    expect(research.properties.decisions.items.required).toContain('requested_domains')
  })

  // Controller carry-forward: the real `claude` CLI rejects a --json-schema carrying the top-level
  // "$schema" dialect key z.toJSONSchema() emits — every schema arg here must strip it the same
  // way protocol.ts's AGENT_REPLY_SCHEMA_ARG does.
  it('drops the top-level "$schema" dialect key the real CLI rejects, for every kind', () => {
    for (const kind of ['planner', 'author', 'research'] as const) {
      expect(REPLY_SCHEMA_ARGS[kind]).not.toContain('$schema')
      expect(JSON.parse(REPLY_SCHEMA_ARGS[kind])).not.toHaveProperty('$schema')
    }
  })

  it('reports a missing field of the kind', () => {
    expect(issuesOf('planner', base)).toEqual(['slices: Invalid input: expected array, received undefined'])
  })
})

describe('planner replies', () => {
  const slices = [{ title: 'Engine', scope: 'The engine.', depends_on: [] }, { title: 'Email', scope: 'Email.', depends_on: [1] }]

  it('accepts 1 to 12 valid slices with decisions about the initiative', () => {
    const decision = { id: 'order', question: 'Email first?', scope: { kind: 'change' }, options: [option('yes'), option('no')], recommended: 'yes', blocking: false }
    expect(issuesOf('planner', { ...base, slices, decisions: [decision] })).toEqual([])
  })

  it('refuses no slices, cycles, scenario scopes and other statuses', () => {
    expect(issuesOf('planner', { ...base, slices: [] })).toEqual(['slices: the planner proposes 1 to 12 slices'])
    expect(issuesOf('planner', { ...base, slices: [{ ...slices[0], depends_on: [2] }, slices[1]] })).toEqual(['slices: dependency cycle s1 → s2 → s1'])
    const scenario = { id: 'x', question: 'Q?', scope: { kind: 'scenario', key: 'k' }, options: [option('a'), option('b')], recommended: null, blocking: false }
    expect(issuesOf('planner', { ...base, slices, decisions: [scenario] })).toEqual(['decisions[0].scope: the planner may raise only decisions about the whole initiative'])
    expect(issuesOf('planner', { ...base, slices, status: 'needs_owner' })).toEqual(['status: the planner replies "done" or "failed"'])
    expect(issuesOf('planner', { ...base, slices: [], status: 'failed' })).toEqual([])
  })
})

describe('author replies', () => {
  it('names the requested change and keeps patch and resolves empty', () => {
    expect(issuesOf('author', { ...base, change: 'add-hs-email' })).toEqual([])
    expect(issuesOf('author', { ...base, change: 'add-other', patch: 'diff', resolves: ['d_1'] })).toEqual([
      'change: "add-other" is not the requested change "add-hs-email"',
      'patch: the author writes files and must set patch to null',
      'resolves: the author resolves no decisions',
    ])
  })

  it('raises only change-scoped decisions while the change does not exist yet', () => {
    const scenario = { id: 'x', question: 'Q?', scope: { kind: 'scenario', key: 'features/a.feature::A' }, options: [option('a'), option('b')], recommended: null, blocking: true }
    expect(issuesOf('author', { ...base, change: 'add-hs-email', status: 'needs_owner', decisions: [scenario] })).toEqual([
      'decisions[0].scope: a needs_owner reply may raise only change-scoped decisions — the change does not exist yet',
    ])
    expect(issuesOf('author', { ...base, change: 'add-hs-email', status: 'done', decisions: [scenario] })).toEqual([])
    expect(issuesOf('author', { ...base, change: 'add-hs-email', status: 'answered' })).toEqual(['status: the author replies "done", "needs_owner" or "failed"'])
  })
})

describe('research replies', () => {
  it('needs a document with sources when done', () => {
    expect(issuesOf('research', { ...base, document: '# Intuit\n\nText.\n\n## Sources\n- https://developer.intuit.com/x\n' })).toEqual([])
    expect(issuesOf('research', { ...base, document: 'No sources.' })).toEqual(['document: a finished research document ends with a "## Sources" list'])
  })

  it('asks for domains only through one blocking fetch-domains decision with the three options', () => {
    expect(issuesOf('research', { ...base, document: '', status: 'needs_owner', decisions: [fetchDomains()] })).toEqual([])
    expect(issuesOf('research', {
      ...base, document: '', status: 'needs_owner',
      decisions: [fetchDomains({ id: 'other', options: [option('a'), option('b')], recommended: null, requested_domains: ['https://x.com', 'docs.stripe.com'] })],
    })).toEqual([
      'decisions[0].id: research may raise only the "fetch-domains" decision',
      'decisions[0].options: exactly allow_all, allow_some and search_only',
      'decisions[0].requested_domains: "https://x.com" is not a plain hostname',
    ])
    expect(issuesOf('research', { ...base, document: 'x\n## Sources\n', decisions: [fetchDomains()] })).toEqual(['decisions: only a needs_owner reply asks for domains'])
  })
})

describe('prompts', () => {
  const doc = { ...emptyInitiative({ name: 'hs', title: 'Health score', repo: 'api', created_at: 'x' }), research: { domains: ['docs.stripe.com'] } }

  it('points the planner at the room', () => {
    const prompt = plannerPrompt(doc, [])
    expect(prompt).toContain('Initiative: hs — Health score (repository api).')
    expect(prompt).toContain('initiative/brief.md')
    expect(prompt).toContain('## Decisions\nNo open or decided decisions.')
  })

  it('gives the author its slice, notes and change directory', () => {
    const prompt = authorPrompt(doc, { id: 's2', title: 'Email', scope: 'Email inputs.', depends_on: ['s1'], change: null }, 'Keep it small.', 'add-hs-email', [])
    expect(prompt).toContain('Slice s2 — Email')
    expect(prompt).toContain('Owner notes: Keep it small.')
    expect(prompt).toContain('/work/out/openspec/changes/add-hs-email/')
  })

  it('asks research its questions and lists the allowed domains', () => {
    const prompt = researchPrompt(doc, 'Intuit reports', 'Which report gives AR ageing?')
    expect(prompt).toContain('Topic: Intuit reports')
    expect(prompt).toContain('Which report gives AR ageing?')
    expect(prompt).toContain('Already allowed for WebFetch: docs.stripe.com')
    expect(researchResumeClosing(['docs.stripe.com'])).toBe('WebFetch is now enabled for: docs.stripe.com. Read the pages you need and reply with the finished document.')
    expect(researchResumeClosing([])).toBe('WebFetch stays disabled (search only). Write the document from the search results and reply with it.')
  })

  it('ships agent rules that forbid prose questions and name the output rules', async () => {
    const rules = async (name: string) => (await readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8')).replace(/\s+/g, ' ')
    expect(await rules('planner.md')).toContain('`slices`')
    expect(await rules('author.md')).toContain('/work/out/openspec/changes/<change>/')
    expect(await rules('research.md')).toContain('fetch-domains')
    for (const name of ['planner.md', 'author.md', 'research.md']) expect(await rules(name)).toContain('never into prose')
  })
})
