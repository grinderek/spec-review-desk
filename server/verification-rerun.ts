import { z } from 'zod'
import type { RunnerProfile } from './config.ts'

// A coalesced request asks for current sources when it starts. It is distinct from
// retrying an attempt whose dispatch or outcome is unknown.
export const VerificationProfileSchema = z.object({
  name: z.string().min(1), worktreePath: z.string().min(1), execution: z.enum(['local', 'compose']),
  compose: z.object({ project: z.string().min(1), files: z.array(z.string().min(1)).min(1), service: z.string().min(1) }).optional(),
  command: z.array(z.string().min(1)).min(1),
}).strict().refine(profile => profile.execution === 'local' || Boolean(profile.compose), 'Compose settings are required')
const Request = z.object({ id: z.uuid(), afterRunId: z.uuid(), at: z.iso.datetime(), profile: VerificationProfileSchema }).strict()
export const VerificationRerunEventSchemas = [
  z.object({ type: z.literal('VerificationRerunRequested'), request: Request }).strict(),
  z.object({ type: z.literal('VerificationRerunStarted'), requestId: z.uuid(), runId: z.uuid() }).strict(),
  z.object({ type: z.literal('VerificationRerunDeferred'), requestId: z.uuid(), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('VerificationRerunCancelled'), requestId: z.uuid(), reason: z.string().min(1) }).strict(),
] as const
export type VerificationRerun = z.infer<typeof Request> & { reason: string | null }
export function captureVerificationProfile(profile: RunnerProfile): z.infer<typeof VerificationProfileSchema> {
  return VerificationProfileSchema.parse({ name: profile.name, worktreePath: profile.worktreePath,
    execution: profile.execution ?? 'compose', ...(profile.compose ? { compose: profile.compose } : {}), command: profile.command })
}
export function restoreVerificationProfile(profile: VerificationRerun['profile']): RunnerProfile {
  return { ...structuredClone(profile), watch: [], applyAllowedTools: [] }
}
