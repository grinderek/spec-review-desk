import { describe, expect, it } from 'vitest'
import {
  AGENT_REPLY_SCHEMA_ARG, type AgentReply, agentReplyJsonSchema, normalizePatch, parseJsonObject, parseReply, type ReplyContext, type ReplyDecision,
  retryPrompt, validateReply,
} from './protocol.ts'

const KEY = 'features/x.feature::A title'
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
const decision = (over: Partial<ReplyDecision> = {}): ReplyDecision => ({
  id: 'storage',
  question: 'Which storage?',
  scope: { kind: 'change' },
  options: [{ id: 'sqlite_path', label: 'SQLite', consequence: 'One file.' }, { id: 'postgres', label: 'Postgres', consequence: 'A server.' }],
  recommended: 'sqlite_path',
  blocking: true,
  ...over,
})
const reply = (over: Partial<AgentReply> = {}): AgentReply => ({ answer: 'Because.', patch: null, decisions: [], resolves: [], status: 'answered', ...over })
const ctx = (over: Partial<ReplyContext> = {}): ReplyContext => ({ agent: 'question', scenarioKeys: [KEY], decisions: [], ...over })

describe('agentReplyJsonSchema', () => {
  it('is a closed object with every field required, slug ids and 2 to 4 options', () => {
    const schema = agentReplyJsonSchema as unknown as { additionalProperties: unknown; required: string[]; properties: Record<string, any> }
    expect(schema.additionalProperties).toBe(false)
    expect([...schema.required].sort()).toEqual(['answer', 'decisions', 'patch', 'resolves', 'status'])
    expect(schema.properties.decisions.maxItems).toBe(5)
    const item = schema.properties.decisions.items
    expect(item.properties.options).toMatchObject({ minItems: 2, maxItems: 4 })
    expect(item.properties.id.pattern).toBe('^[a-z0-9][a-z0-9_-]{0,39}$')
    expect(JSON.parse(AGENT_REPLY_SCHEMA_ARG)).toEqual(agentReplyJsonSchema)
  })
})

describe('parseReply', () => {
  it('accepts a valid reply', () => {
    expect(parseReply(reply({ decisions: [decision()] }))).toEqual({ reply: reply({ decisions: [decision()] }), issues: [] })
  })

  it('reports a missing structured output', () => {
    expect(parseReply(null)).toEqual({ reply: null, issues: ['(root): the reply carries no structured output'] })
    expect(parseReply(undefined).reply).toBeNull()
  })

  it('lists schema issues with their paths', () => {
    const bad = { ...reply(), decisions: [{ ...decision(), id: 'Bad Id', options: [decision().options[0]] }], extra: 1 }
    const { reply: parsed, issues } = parseReply(bad)
    expect(parsed).toBeNull()
    expect(issues.some((i) => i.startsWith('decisions.0.id:'))).toBe(true)
    expect(issues.some((i) => i.startsWith('decisions.0.options:'))).toBe(true)
    expect(issues.some((i) => i.includes('extra'))).toBe(true)
  })

  it('normalizes the patch: fences stripped, blank to null, trailing newline added', () => {
    expect(parseReply(reply({ patch: `\`\`\`diff\n${DIFF}\`\`\`` })).reply?.patch).toBe(DIFF)
    expect(parseReply(reply({ patch: '  ' })).reply?.patch).toBeNull()
    expect(parseReply(reply({ patch: DIFF.trimEnd() })).reply?.patch).toBe(DIFF)
    expect(normalizePatch(null)).toBeNull()
  })

  it('parses a JSON object string and nothing else', () => {
    expect(parseJsonObject(' {"a":1} ')).toEqual({ a: 1 })
    expect(parseJsonObject('All green.')).toBeNull()
    expect(parseJsonObject('{broken')).toBeNull()
  })
})

describe('validateReply', () => {
  it('accepts a clean question reply', () => {
    expect(validateReply(reply({ decisions: [decision()] }), ctx())).toEqual([])
  })

  it('catches a recommendation that is not an option id (the spike case)', () => {
    expect(validateReply(reply({ decisions: [decision({ recommended: 'sqlite' })] }), ctx())).toEqual([
      'decisions[0].recommended: "sqlite" is not one of the option ids (sqlite_path, postgres)',
    ])
  })

  it('catches duplicate ids and unknown scenario keys', () => {
    const first = decision().options[0]!
    const duplicated = decision({ options: [first, { ...first }], recommended: null })
    const unknownKey = decision({ scope: { kind: 'scenario', key: 'features/x.feature::Nope' } })
    expect(validateReply(reply({ decisions: [duplicated, unknownKey] }), ctx())).toEqual([
      'decisions[0].options: option ids must be unique',
      'decisions[1].id: "storage" is used by another decision in this reply',
      'decisions[1].scope.key: no scenario "features/x.feature::Nope" in this change',
    ])
  })

  it('enforces the status and patch rules per agent', () => {
    expect(validateReply(reply({ status: 'done' }), ctx())).toEqual(['status: the question agent always replies "answered", not "done"'])
    const apply = ctx({ agent: 'apply' })
    expect(validateReply(reply({ status: 'done' }), apply)).toEqual([])
    expect(validateReply(reply(), apply)).toEqual(['status: the Apply agent replies "done", "needs_owner" or "failed"'])
    expect(validateReply(reply({ status: 'done', patch: DIFF }), apply)).toEqual(['patch: the Apply agent edits files directly and must set patch to null'])
    expect(validateReply(reply({ status: 'needs_owner', decisions: [decision({ blocking: false })] }), apply)).toEqual([
      'status: "needs_owner" needs at least one blocking decision',
    ])
    expect(validateReply(reply({ status: 'needs_owner', decisions: [decision()] }), apply)).toEqual([])
  })

  it('accepts resolves only for decided, scenario-scoped decisions together with a patch', () => {
    const c = ctx({
      decisions: [
        { id: 'd_decided', status: 'decided', scope: { kind: 'scenario', key: KEY } },
        { id: 'd_open', status: 'open', scope: { kind: 'scenario', key: KEY } },
        { id: 'd_change', status: 'decided', scope: { kind: 'change' } },
      ],
    })
    expect(validateReply(reply({ patch: DIFF, resolves: ['d_decided'] }), c)).toEqual([])
    expect(validateReply(reply({ resolves: ['d_decided'] }), c)).toEqual(['resolves: only a reply with a patch can resolve decisions'])
    expect(validateReply(reply({ patch: DIFF, resolves: ['d_nope', 'd_open', 'd_change'] }), c)).toEqual([
      'resolves: no decision "d_nope"',
      'resolves: decision "d_open" is open, not decided',
      'resolves: decision "d_change" is scoped to the whole change — the Desk records it in decisions.md',
    ])
  })

  it('builds the retry prompt', () => {
    expect(retryPrompt(['a: x', 'b: y'])).toBe('Your reply did not pass validation: a: x; b: y. Reply again with the same schema.')
  })
})
