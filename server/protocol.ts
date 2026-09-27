import { z } from 'zod'
import { extractPatch } from './patch.ts'

// The one reply protocol of every agent the Desk runs (spec §4). The zod schema is the source of
// truth: its JSON Schema goes to the CLI as `--json-schema`, and the server validates again, because
// JSON Schema cannot express the cross-field rules of validateReply (spike 2026-09-24:
// `recommended: "sqlite"` while the option ids were `sqlite_path`/…).
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/
const Slug = z.string().regex(SLUG)

export const OptionSchema = z.strictObject({
  id: Slug,
  label: z.string().min(1).max(120),
  consequence: z.string().min(1).max(400),
})
export const ScopeSchema = z.union([
  z.strictObject({ kind: z.literal('scenario'), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal('change') }),
])
export const ReplyDecisionSchema = z.strictObject({
  id: Slug,
  question: z.string().min(1).max(400),
  scope: ScopeSchema,
  options: z.array(OptionSchema).min(2).max(4),
  recommended: z.string().nullable(),
  blocking: z.boolean(),
})
export const AgentReplySchema = z.strictObject({
  answer: z.string(),
  patch: z.string().nullable(),
  decisions: z.array(ReplyDecisionSchema).max(5),
  resolves: z.array(z.string()).max(5),
  status: z.enum(['answered', 'needs_owner', 'done', 'failed']),
})

export type AgentReply = z.infer<typeof AgentReplySchema>
export type ReplyDecision = z.infer<typeof ReplyDecisionSchema>
export type DecisionScope = z.infer<typeof ScopeSchema>
export type AgentKind = 'question' | 'apply'
export interface KnownDecision { id: string; status: 'open' | 'decided' | 'recorded' | 'dismissed'; scope: DecisionScope }
export interface ReplyContext { agent: AgentKind; scenarioKeys: readonly string[]; decisions: readonly KnownDecision[] }

export const agentReplyJsonSchema = z.toJSONSchema(AgentReplySchema)
// The real `claude` CLI's --json-schema validator rejects the top-level "$schema" dialect key
// z.toJSONSchema() emits (verified 2026-09-27 against the real CLI: "no schema with key or ref
// https://json-schema.org/draft/2020-12/schema"). Strip it — immutably — for the arg the CLI sees;
// agentReplyJsonSchema itself (used by tests and anything else that wants the full JSON Schema)
// keeps it.
const { $schema: _agentReplySchemaDialect, ...agentReplyJsonSchemaForCli } = agentReplyJsonSchema
export const AGENT_REPLY_SCHEMA_ARG = JSON.stringify(agentReplyJsonSchemaForCli)

export function normalizePatch(patch: string | null): string | null {
  if (patch === null) return null
  const body = extractPatch(patch) ?? patch
  if (!body.trim()) return null
  return body.endsWith('\n') ? body : `${body}\n`
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

export function parseReply(raw: unknown): { reply: AgentReply | null; issues: string[] } {
  if (raw === null || raw === undefined) return { reply: null, issues: ['(root): the reply carries no structured output'] }
  const result = AgentReplySchema.safeParse(raw)
  if (!result.success) {
    return { reply: null, issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  }
  return { reply: { ...result.data, patch: normalizePatch(result.data.patch) }, issues: [] }
}

// Final review Important 1(c): agents are never shown the scenario keys they must echo, so the
// one retry after an unknown-key failure is a blind guess unless the issue text itself lists the
// valid keys. Capped so a large change's list stays a useful hint, not a wall of text.
const MAX_LISTED_SCENARIO_KEYS = 50

function scenarioKeyHint(keys: ReadonlySet<string>): string {
  if (keys.size === 0) return 'this change has no scenarios'
  const all = [...keys]
  const shown = all.slice(0, MAX_LISTED_SCENARIO_KEYS).join(', ')
  const more = all.length > MAX_LISTED_SCENARIO_KEYS ? `, and ${all.length - MAX_LISTED_SCENARIO_KEYS} more` : ''
  return `valid keys: ${shown}${more}`
}

export function decisionIssues(d: ReplyDecision, at: string, earlierIds: readonly string[], keys: ReadonlySet<string>): string[] {
  const ids = d.options.map((o) => o.id)
  return [
    ...(earlierIds.includes(d.id) ? [`${at}.id: "${d.id}" is used by another decision in this reply`] : []),
    ...(new Set(ids).size !== ids.length ? [`${at}.options: option ids must be unique`] : []),
    ...(d.recommended !== null && !ids.includes(d.recommended)
      ? [`${at}.recommended: "${d.recommended}" is not one of the option ids (${ids.join(', ')})`]
      : []),
    ...(d.scope.kind === 'scenario' && !keys.has(d.scope.key)
      ? [`${at}.scope.key: no scenario "${d.scope.key}" in this change (${scenarioKeyHint(keys)})`]
      : []),
  ]
}

function statusIssues(reply: AgentReply, agent: AgentKind): string[] {
  return [
    ...(agent === 'question' && reply.status !== 'answered' ? [`status: the question agent always replies "answered", not "${reply.status}"`] : []),
    ...(agent === 'apply' && reply.status === 'answered' ? ['status: the Apply agent replies "done", "needs_owner" or "failed"'] : []),
    ...(agent === 'apply' && reply.patch !== null ? ['patch: the Apply agent edits files directly and must set patch to null'] : []),
    ...(reply.status === 'needs_owner' && !reply.decisions.some((d) => d.blocking) ? ['status: "needs_owner" needs at least one blocking decision'] : []),
  ]
}

function resolveIssues(reply: AgentReply, decisions: readonly KnownDecision[]): string[] {
  const withoutPatch = reply.resolves.length && reply.patch === null ? ['resolves: only a reply with a patch can resolve decisions'] : []
  return [
    ...withoutPatch,
    ...reply.resolves.flatMap((id) => {
      const d = decisions.find((x) => x.id === id)
      if (!d) return [`resolves: no decision "${id}"`]
      if (d.status !== 'decided') return [`resolves: decision "${id}" is ${d.status}, not decided`]
      if (d.scope.kind !== 'scenario') return [`resolves: decision "${id}" is scoped to the whole change — the Desk records it in decisions.md`]
      return []
    }),
  ]
}

export function validateReply(reply: AgentReply, ctx: ReplyContext): string[] {
  const keys = new Set(ctx.scenarioKeys)
  return [
    ...reply.decisions.flatMap((d, i) => decisionIssues(d, `decisions[${i}]`, reply.decisions.slice(0, i).map((x) => x.id), keys)),
    ...statusIssues(reply, ctx.agent),
    ...resolveIssues(reply, ctx.decisions),
  ]
}

export const retryPrompt = (issues: readonly string[]): string =>
  `Your reply did not pass validation: ${issues.join('; ')}. Reply again with the same schema.`
