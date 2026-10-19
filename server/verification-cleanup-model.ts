import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { verificationContainerName, type VerificationContainer, type ContainerObservation } from './verification-container.ts'

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Target = z.object({ runId: z.uuid(), attemptId: z.uuid(), name: z.string(), containerId: Hash })
export const VerificationCleanupTerminalProofSchema = z.object({ status: z.enum(['exited', 'dead']), exitCode: z.number().int(), restartPolicy: z.literal('no'), restartCount: z.literal(0) }).strict()
export type VerificationCleanupTerminalProof = z.infer<typeof VerificationCleanupTerminalProofSchema>
export const VerificationCleanupEventSchemas = [
  Target.extend({ type: z.literal('VerificationCleanupRequested'), receiptHash: Hash, artifactHash: Hash.nullable() }).strict(),
  Target.extend({ type: z.literal('VerificationAbandonedCleanupRequested'), terminal: VerificationCleanupTerminalProofSchema }).strict(),
  Target.extend({ type: z.literal('VerificationCleanupDeferred'), reason: z.string().min(1) }).strict(),
  Target.extend({ type: z.literal('VerificationCleanupCompleted') }).strict(),
] as const
export const VerificationCleanupEventSchema = z.discriminatedUnion('type', VerificationCleanupEventSchemas)
export type VerificationCleanupEvent = z.infer<typeof VerificationCleanupEventSchema>
export const VerificationCleanupRecordSchema = Target.extend({ receiptHash: Hash.nullable(), artifactHash: Hash.nullable(), basis: z.enum(['classified-result', 'owner-abandonment']), terminal: VerificationCleanupTerminalProofSchema.nullable(), status: z.enum(['requested', 'blocked', 'completed']), reason: z.string().nullable() })
export type VerificationCleanupRecord = z.infer<typeof VerificationCleanupRecordSchema>
export type VerificationCleanupState = Record<string, VerificationCleanupRecord>
export interface VerificationCleanupEvidence {
  runId: string
  attemptId: string
  receiptHash: string | null
  artifactHash: string | null
  settled: boolean
  classified: boolean
  container: VerificationContainer | null
}
export interface VerificationAbandonedCleanupEvidence {
  runId: string
  attemptId: string
  ownerAbandoned: boolean
  terminal: VerificationCleanupTerminalProof | null
  container: VerificationContainer | null
}
export function verificationCleanupTerminalProof(observed: ContainerObservation): VerificationCleanupTerminalProof {
  if (observed.kind !== 'terminal') throw new Error('Owner abandonment cleanup requires a verified non-restarting terminal container')
  return VerificationCleanupTerminalProofSchema.parse({ status: observed.status, exitCode: observed.exitCode, restartPolicy: 'no', restartCount: 0 })
}
export function decideVerificationAbandonedCleanupRequest(state: VerificationCleanupState, evidence: VerificationAbandonedCleanupEvidence): VerificationCleanupEvent[] {
  if (!evidence.ownerAbandoned || !evidence.terminal || !evidence.container?.id) throw new Error('Unclassified cleanup requires explicit owner abandonment and terminal container proof')
  const event = VerificationCleanupEventSchemas[1].parse({ type: 'VerificationAbandonedCleanupRequested', runId: evidence.runId, attemptId: evidence.attemptId, name: evidence.container.name, containerId: evidence.container.id, terminal: evidence.terminal })
  if (event.name !== verificationContainerName(event.attemptId)) throw new Error('Abandoned cleanup container name does not belong to the attempt')
  const previous = state[event.attemptId]
  if (previous) {
    if (previous.basis !== 'owner-abandonment' || previous.runId !== event.runId || previous.containerId !== event.containerId || previous.name !== event.name || !isDeepStrictEqual(previous.terminal, event.terminal)) throw new Error('Conflicting owner abandonment cleanup intent')
    return []
  }
  return [event]
}
function target(record: VerificationCleanupRecord) {
  return { runId: record.runId, attemptId: record.attemptId, name: record.name, containerId: record.containerId }
}
export function decideVerificationCleanupRequest(state: VerificationCleanupState, evidence: VerificationCleanupEvidence): VerificationCleanupEvent[] {
  if (!evidence.settled || !evidence.classified || !evidence.receiptHash || !evidence.container?.id) throw new Error('Cleanup requires an accepted terminal receipt, classified report and immutable container ID')
  const event = VerificationCleanupEventSchemas[0].parse({ type: 'VerificationCleanupRequested', runId: evidence.runId, attemptId: evidence.attemptId, name: evidence.container.name,
    containerId: evidence.container.id, receiptHash: evidence.receiptHash, artifactHash: evidence.artifactHash })
  if (event.name !== verificationContainerName(event.attemptId)) throw new Error('Cleanup container name does not belong to the attempt')
  const previous = state[event.attemptId]
  if (previous) {
    if (previous.runId !== event.runId || previous.containerId !== event.containerId || previous.name !== event.name || previous.receiptHash !== event.receiptHash || previous.artifactHash !== event.artifactHash) throw new Error('Conflicting verification cleanup intent')
    return []
  }
  return [event]
}
export function projectVerificationCleanup(state: VerificationCleanupState, raw: VerificationCleanupEvent, evidence?: VerificationCleanupEvidence | VerificationAbandonedCleanupEvidence): void {
  const event = VerificationCleanupEventSchema.parse(raw)
  if (event.name !== verificationContainerName(event.attemptId)) throw new Error('Cleanup event has a mismatched attempt name')
  if (event.type === 'VerificationAbandonedCleanupRequested') {
    if (!evidence || !('ownerAbandoned' in evidence)) throw new Error('Cleanup intent requires explicit owner abandonment evidence')
    const expected = decideVerificationAbandonedCleanupRequest(state, evidence)[0]
    if (!expected || expected.type !== 'VerificationAbandonedCleanupRequested' || expected.runId !== event.runId || expected.attemptId !== event.attemptId || expected.name !== event.name || expected.containerId !== event.containerId || !isDeepStrictEqual(expected.terminal, event.terminal)) throw new Error('Cleanup intent does not match this abandoned terminal container')
    state[event.attemptId] = { runId: event.runId, attemptId: event.attemptId, name: event.name, containerId: event.containerId, receiptHash: null, artifactHash: null, basis: 'owner-abandonment', terminal: structuredClone(event.terminal), status: 'requested', reason: null }
    return
  }
  if (event.type === 'VerificationCleanupRequested') {
    if (!evidence || !('receiptHash' in evidence)) throw new Error('Cleanup intent requires accepted execution evidence')
    const decided = decideVerificationCleanupRequest(state, evidence)
    const expected = decided[0]
    if (!expected || expected.type !== 'VerificationCleanupRequested' || expected.runId !== event.runId || expected.attemptId !== event.attemptId || expected.name !== event.name || expected.containerId !== event.containerId || expected.receiptHash !== event.receiptHash || expected.artifactHash !== event.artifactHash) throw new Error('Cleanup intent is not bound to this accepted result')
    state[event.attemptId] = { runId: event.runId, attemptId: event.attemptId, name: event.name, containerId: event.containerId, receiptHash: event.receiptHash, artifactHash: event.artifactHash, basis: 'classified-result', terminal: null, status: 'requested', reason: null }
    return
  }
  const previous = state[event.attemptId]
  if (!previous || previous.runId !== event.runId || previous.name !== event.name || previous.containerId !== event.containerId || previous.status === 'completed') throw new Error('Cleanup event has no outstanding matching intent')
  previous.status = event.type === 'VerificationCleanupCompleted' ? 'completed' : 'blocked'
  previous.reason = event.type === 'VerificationCleanupDeferred' ? event.reason : null
}
export function decideVerificationCleanupObservation(record: VerificationCleanupRecord, observed: 'missing' | { reason: string }): VerificationCleanupEvent[] {
  if (record.status === 'completed') return []
  if (observed === 'missing') return [{ type: 'VerificationCleanupCompleted', ...target(record) }]
  if (record.status === 'blocked' && record.reason === observed.reason) return []
  return [{ type: 'VerificationCleanupDeferred', ...target(record), reason: observed.reason }]
}
export const verificationCleanupPending = (state: VerificationCleanupState): boolean => Object.values(state).some(record => record.status !== 'completed')

// Includes a terminal container with a rejected report and a planned-but-unidentified resource.
// Neither outcome classification nor missing cleanup evidence may silently release its gate.
export function verificationContainersPending(containers: Record<string, VerificationContainer>, state: VerificationCleanupState): boolean {
  return Object.entries(containers).some(([attemptId, container]) => {
    const cleanup = state[attemptId]
    return !cleanup || cleanup.status !== 'completed' || !container.id || cleanup.containerId !== container.id || cleanup.name !== container.name
  })
}
