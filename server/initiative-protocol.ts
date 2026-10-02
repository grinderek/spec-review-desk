import { z } from 'zod'
import { FETCH_DOMAINS, normalizeDomain } from './egress.ts'
import type { RunKind } from './initiative-store.ts'
import { AgentReplySchema, decisionIssues, ReplyDecisionSchema } from './protocol.ts'
import { plannerSliceIssues } from './slice-plan.ts'

// Spec B §4.2/§4.4/§4.5: A's AgentReply plus one field per agent, closed like A's schema.
const PlannerSliceSchema = z.strictObject({
  title: z.string().min(1).max(120),
  scope: z.string().min(1).max(2000),
  depends_on: z.array(z.number().int()).max(12),
})
export const PlannerReplySchema = AgentReplySchema.extend({ slices: z.array(PlannerSliceSchema).max(12) })
export const AuthorReplySchema = AgentReplySchema.extend({ change: z.string() })
const ResearchDecisionSchema = ReplyDecisionSchema.extend({ requested_domains: z.array(z.string()).max(20) })
export const ResearchReplySchema = AgentReplySchema.extend({ decisions: z.array(ResearchDecisionSchema).max(5), document: z.string() })

export type PlannerReply = z.infer<typeof PlannerReplySchema>
export type AuthorReply = z.infer<typeof AuthorReplySchema>
export type ResearchReply = z.infer<typeof ResearchReplySchema>
export interface RunReplies { planner: PlannerReply; author: AuthorReply; research: ResearchReply }
export type RunReply = RunReplies[RunKind]
export interface RunReplyContext { change?: string }

const SCHEMAS = { planner: PlannerReplySchema, author: AuthorReplySchema, research: ResearchReplySchema } as const

// Codex receives a dialect-neutral JSON Schema file for each agent role.
const withoutSchemaDialect = (jsonSchema: object): object => {
  const { $schema: _dialect, ...rest } = jsonSchema as { $schema?: string }
  return rest
}

export const REPLY_SCHEMA_ARGS: Record<RunKind, string> = Object.fromEntries(
  (Object.entries(SCHEMAS) as [RunKind, z.ZodType][]).map(([kind, schema]) => [kind, JSON.stringify(withoutSchemaDialect(z.toJSONSchema(schema)))]),
) as Record<RunKind, string>

export function parseRunReply<K extends RunKind>(kind: K, raw: unknown): { reply: RunReplies[K] | null; issues: string[] } {
  if (raw === null || raw === undefined) return { reply: null, issues: ['(root): the reply carries no structured output'] }
  const result = SCHEMAS[kind].safeParse(raw)
  if (!result.success) return { reply: null, issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  return { reply: result.data as RunReplies[K], issues: [] }
}

function commonIssues(kind: RunKind, reply: RunReply): string[] {
  const scenarioScoped = (i: number) =>
    kind === 'author'
      ? `decisions[${i}].scope: a needs_owner reply may raise only change-scoped decisions — the change does not exist yet`
      : `decisions[${i}].scope: the ${kind} may raise only decisions about the whole initiative`
  // Scenario keys of a finished author are checked against the vetted change later (vetting).
  const keys = new Set(reply.decisions.flatMap((d) => (d.scope.kind === 'scenario' ? [d.scope.key] : [])))
  return [
    ...reply.decisions.flatMap((d, i) => decisionIssues(d, `decisions[${i}]`, reply.decisions.slice(0, i).map((x) => x.id), keys)),
    ...reply.decisions.flatMap((d, i) =>
      d.scope.kind === 'scenario' && !(kind === 'author' && reply.status === 'done') ? [scenarioScoped(i)] : []),
    ...(reply.status === 'needs_owner' && kind !== 'planner' && !reply.decisions.some((d) => d.blocking) ? ['status: "needs_owner" needs at least one blocking decision'] : []),
  ]
}

function plannerIssues(reply: PlannerReply): string[] {
  if (reply.status !== 'done' && reply.status !== 'failed') return ['status: the planner replies "done" or "failed"']
  if (reply.status === 'failed') return []
  if (reply.slices.length === 0) return ['slices: the planner proposes 1 to 12 slices']
  return plannerSliceIssues(reply.slices)
}

function authorIssues(reply: AuthorReply, ctx: RunReplyContext): string[] {
  return [
    ...(reply.status === 'answered' ? ['status: the author replies "done", "needs_owner" or "failed"'] : []),
    ...(ctx.change !== undefined && reply.change !== ctx.change ? [`change: "${reply.change}" is not the requested change "${ctx.change}"`] : []),
    ...(reply.patch !== null ? ['patch: the author writes files and must set patch to null'] : []),
    ...(reply.resolves.length ? ['resolves: the author resolves no decisions'] : []),
  ]
}

function researchIssues(reply: ResearchReply): string[] {
  if (reply.status === 'answered') return ['status: research replies "done", "needs_owner" or "failed"']
  if (reply.status !== 'needs_owner' && reply.decisions.length) return ['decisions: only a needs_owner reply asks for domains']
  if (reply.status === 'done' && !/^## Sources\s*$/m.test(reply.document)) return ['document: a finished research document ends with a "## Sources" list']
  return reply.decisions.flatMap((d, i) => [
    ...(d.id !== FETCH_DOMAINS.id ? [`decisions[${i}].id: research may raise only the "fetch-domains" decision`] : []),
    ...(d.options.map((o) => o.id).join(',') !== FETCH_DOMAINS.options.join(',') ? [`decisions[${i}].options: exactly allow_all, allow_some and search_only`] : []),
    ...(d.requested_domains.length === 0 ? [`decisions[${i}].requested_domains: name at least one domain`] : []),
    ...d.requested_domains.flatMap((h) => (normalizeDomain(h) === null ? [`decisions[${i}].requested_domains: "${h}" is not a plain hostname`] : [])),
  ])
}

export function validateRunReply(kind: RunKind, reply: RunReply, ctx: RunReplyContext = {}): string[] {
  const own = kind === 'planner' ? plannerIssues(reply as PlannerReply) : kind === 'author' ? authorIssues(reply as AuthorReply, ctx) : researchIssues(reply as ResearchReply)
  return [...commonIssues(kind, reply), ...own]
}
