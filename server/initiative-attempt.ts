import { z } from 'zod'
import { AgentExecutionSpecSchema } from './execution-model.ts'
export const InitiativeAttemptInputSchema = z.object({
  version: z.literal(1), attemptId: z.uuid(), runId: z.string(), kind: z.enum(['research', 'planner', 'author']),
  provider: z.object({ module: z.string(), config: z.unknown() }),
  sandboxId: z.string(), runDir: z.string(), room: z.string(), out: z.string(), sessions: z.string(), log: z.string(),
  timeoutMs: z.number().positive(), domains: z.array(z.string()), browser: z.boolean(),
  codex: AgentExecutionSpecSchema,
  source: z.object({ journal: z.string(), brief: z.string(), inputs: z.array(z.object({ file: z.string(), blob: z.string(), draft: z.boolean() })), planHash: z.string(), roomHash: z.string() }),
})
export const InitiativeAttemptResultSchema = z.object({
  version: z.literal(1), attemptId: z.uuid(),
  outcome: z.object({ code: z.number().nullable(), stopped: z.boolean(), timedOut: z.boolean(), error: z.string().nullable() }),
  result: z.object({ ok: z.boolean(), text: z.string(), sessionId: z.string(), structured: z.unknown().optional() }).nullable(),
  sawSecret: z.boolean(),
  outputs: z.array(z.object({ path: z.string(), content: z.string(), mode: z.number() })),
  usage: z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).nullable(), toolCalls: z.number(),
})
export type InitiativeAttemptInput = z.infer<typeof InitiativeAttemptInputSchema>
export type InitiativeAttemptResult = z.infer<typeof InitiativeAttemptResultSchema>
