import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RoutingDecisionSchema } from './agent-routing.ts'

export const ExecutionRoleSchema = z.enum(['reviewer', 'apply', 'research', 'planner', 'author', 'verification'])
export const ExecutionOutcomeSchema = z.enum(['queued', 'running', 'needs_owner', 'done', 'failed', 'stopped', 'uncertain'])
export const ProcessBoundarySchema = z.object({ bootId: z.string().min(1), startTicks: z.string().regex(/^\d+$/) })
export type ProcessBoundary = z.infer<typeof ProcessBoundarySchema>
export const ProcessIdentitySchema = z.object({ pid: z.number().int().positive(), bootId: z.string().min(1), startTicks: z.string().regex(/^\d+$/), attemptId: z.uuid() })
export const AgentExecutionSpecSchema = z.object({
  kind: z.literal('agent'),
  bin: z.string().min(1), cwd: z.string().min(1), sessionId: z.string(), resume: z.boolean(), model: z.string(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  allowedTools: z.array(z.string()), disallowedTools: z.array(z.string()), permissionMode: z.enum(['default', 'acceptEdits']),
  appendSystemPrompt: z.string().nullable(), prompt: z.string().max(2_000_000), jsonSchema: z.string().nullable().optional(),
  schemaFile: z.string().optional(), toolsScript: z.string().optional(), writeRoot: z.string().optional(),
  search: z.boolean().optional(), readDomains: z.array(z.string()).optional(),
})
export const CommandExecutionSpecSchema = z.object({
  kind: z.literal('command'), bin: z.string().min(1), cwd: z.string().min(1),
  args: z.array(z.string().max(100_000)).max(1000),
  environment: z.record(z.string().regex(/^DESK_[A-Z0-9_]+$/), z.string().max(4096)),
  resultFile: z.string().min(1).nullable(),
})
export const ExecutionSpecSchema = z.discriminatedUnion('kind', [AgentExecutionSpecSchema, CommandExecutionSpecSchema])
export const ExecutionRequestSchema = z.object({
  id: z.uuid(), role: ExecutionRoleSchema, threadId: z.string().nullable(), messageCount: z.number().int().nonnegative(), at: z.string(),
})
export const ExecutionAttemptSchema = z.object({
  id: z.uuid(), at: z.string(), cause: z.enum(['initial', 'owner-resume', 'validation-retry', 'missing-session']),
  head: z.string(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/), spec: ExecutionSpecSchema, routing: RoutingDecisionSchema.nullable(),
  decisions: z.array(z.unknown()),
  processBoundary: ProcessBoundarySchema.optional(),
})
export const ExecutionEventSchemas = [
  z.object({ type: z.literal('ExecutionQueued'), request: ExecutionRequestSchema }),
  z.object({ type: z.literal('ExecutionAttemptRequested'), runId: z.uuid(), attempt: ExecutionAttemptSchema }),
  z.object({ type: z.literal('ExecutionAttemptObserved'), runId: z.uuid(), attemptId: z.uuid(), identity: ProcessIdentitySchema }),
  z.object({ type: z.literal('ExecutionStopRequested'), runId: z.uuid(), attemptId: z.uuid() }),
  z.object({ type: z.literal('ExecutionReceiptAccepted'), runId: z.uuid(), attemptId: z.uuid(), receiptHash: z.string().regex(/^[0-9a-f]{64}$/), session: z.string().nullable() }),
  z.object({ type: z.literal('ExecutionSettled'), runId: z.uuid(), attemptId: z.uuid(), outcome: z.enum(['needs_owner', 'done', 'failed', 'stopped']), at: z.string() }),
  z.object({ type: z.literal('ExecutionUncertain'), runId: z.uuid(), attemptId: z.uuid().nullable(), reason: z.string() }),
] as const
export const ExecutionEventSchema = z.discriminatedUnion('type', ExecutionEventSchemas)
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>
export const ExecutionRunSchema = z.object({
  request: ExecutionRequestSchema, outcome: ExecutionOutcomeSchema, endedAt: z.string().nullable(), reason: z.string().nullable(),
  attempts: z.array(ExecutionAttemptSchema.extend({ identity: ProcessIdentitySchema.nullable(), receiptHash: z.string().nullable(), session: z.string().nullable(), stopRequested: z.boolean() })),
})
export type ExecutionRun = z.infer<typeof ExecutionRunSchema>
export function queueExecution(role: ExecutionRequest['role'], threadId: string | null = null, messageCount = 0, at = new Date().toISOString()): ExecutionEvent {
  return { type: 'ExecutionQueued', request: { id: randomUUID(), role, threadId, messageCount, at } }
}
export function projectExecution(runs: ExecutionRun[], event: ExecutionEvent): void {
  if (event.type === 'ExecutionQueued') {
    if (runs.some(run => run.request.id === event.request.id)) throw new Error('Duplicate execution request')
    runs.push({ request: structuredClone(event.request), outcome: 'queued', endedAt: null, reason: null, attempts: [] }); return
  }
  const run = runs.find(run => run.request.id === event.runId)
  if (!run) throw new Error('Execution event refers to an unknown request')
  if (event.type === 'ExecutionAttemptRequested') {
    const previous = run.attempts.at(-1)
    if (previous && !previous.receiptHash && run.outcome !== 'uncertain') throw new Error('Previous execution attempt has no accepted result')
    if (runs.some(other => other.attempts.some(attempt => attempt.id === event.attempt.id))) throw new Error('Duplicate execution attempt')
    run.attempts.push({ ...structuredClone(event.attempt), identity: null, receiptHash: null, session: null, stopRequested: false })
    run.outcome = 'running'; run.endedAt = null; run.reason = null; return
  }
  if (event.type === 'ExecutionUncertain') {
    if (event.attemptId !== (run.attempts.at(-1)?.id ?? null)) throw new Error('Uncertainty refers to an outdated attempt')
    run.outcome = 'uncertain'; run.reason = event.reason; return
  }
  const attempt = run.attempts.at(-1)
  if (!attempt || attempt.id !== event.attemptId) throw new Error('Execution event refers to an outdated attempt')
  if (event.type === 'ExecutionAttemptObserved') {
    if (event.identity.attemptId !== attempt.id || attempt.identity || attempt.receiptHash) throw new Error('Invalid execution identity observation')
    attempt.identity = structuredClone(event.identity)
  } else if (event.type === 'ExecutionStopRequested') attempt.stopRequested = true
  else if (event.type === 'ExecutionReceiptAccepted') {
    if (attempt.receiptHash) throw new Error('Execution receipt was already accepted')
    attempt.receiptHash = event.receiptHash; attempt.session = event.session
  } else {
    if (!attempt.receiptHash || run.outcome !== 'running' && run.outcome !== 'uncertain') throw new Error('Execution settled without a new accepted receipt')
    run.outcome = event.outcome; run.endedAt = event.at; run.reason = null
  }
}
export const executionBusy = (run: ExecutionRun): boolean => ['queued', 'running', 'uncertain'].includes(run.outcome)
