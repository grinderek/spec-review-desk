import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { ExecutionEventSchemas, executionBusy, projectExecution, type ExecutionEvent, type ExecutionRun } from './execution-model.ts'
import { HttpError } from './errors.ts'
import { withReviewLock } from './review-lock.ts'
import { VerificationSourceSchema, type VerificationSource } from './verification-source.ts'
import { VerificationRerunEventSchemas, type VerificationRerun } from './verification-rerun.ts'
import { VerificationCleanupEventSchemas, projectVerificationCleanup, type VerificationCleanupState } from './verification-cleanup-model.ts'

const Status = z.enum(['passed', 'failed', 'undefined', 'pending', 'skipped', 'ambiguous', 'unknown'])
export const CorpusRunSchema = z.object({
  scenarios: z.record(z.string(), z.object({ status: Status, failure: z.object({ step: z.string(), message: z.string() }).nullable(), rows: z.array(Status).nullable() })),
  totals: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), other: z.number().int().nonnegative() }),
  finishedAt: z.iso.datetime(),
})
export const VerificationEventSchema = z.discriminatedUnion('type', [
  ...ExecutionEventSchemas,
  ...VerificationRerunEventSchemas,
  ...VerificationCleanupEventSchemas,
  z.object({ type: z.literal('VerificationSourceCaptured'), runId: z.uuid(), source: VerificationSourceSchema }),
  z.object({ type: z.literal('VerificationReportAccepted'), runId: z.uuid(), attemptId: z.uuid(), artifactHash: z.string().regex(/^[0-9a-f]{64}$/), sourceUnchanged: z.boolean(), commandError: z.string().nullable(), report: CorpusRunSchema }),
  z.object({ type: z.literal('VerificationReportRejected'), runId: z.uuid(), attemptId: z.uuid(), reason: z.string().min(1) }),
  z.object({ type: z.literal('VerificationRetryAuthorized'), runId: z.uuid(), attemptId: z.uuid().nullable() }),
  z.object({ type: z.literal('VerificationLaunchRejected'), runId: z.uuid(), attemptId: z.uuid(), reason: z.string().min(1), stopped: z.boolean(), at: z.iso.datetime() }),
  z.object({ type: z.literal('VerificationContainerPlanned'), runId: z.uuid(), attemptId: z.uuid(), name: z.string().regex(/^srd-verification-[0-9a-f-]{36}$/) }),
  z.object({ type: z.literal('VerificationContainerObserved'), runId: z.uuid(), attemptId: z.uuid(), containerId: z.string().regex(/^[0-9a-f]{64}$/) }),
])
export type VerificationEvent = z.infer<typeof VerificationEventSchema>
const Envelope = z.object({ version: z.literal(1), stream: z.uuid(), sequence: z.number().int().positive(), id: z.uuid(), command: z.uuid(), at: z.iso.datetime(), event: VerificationEventSchema })
export type VerificationEnvelope = z.infer<typeof Envelope>
export interface VerificationProjection {
  runs: ExecutionRun[]
  sources: Record<string, VerificationSource>
  reports: Record<string, Extract<VerificationEvent, { type: 'VerificationReportAccepted' }>>
  rejections: Record<string, string>
  abandoned: string[]
  containers: Record<string, { name: string; id: string | null }>
  rerun: VerificationRerun | null
  cleanups: VerificationCleanupState
}
export function projectVerification(events: readonly VerificationEnvelope[]): VerificationProjection {
  const state: VerificationProjection = { runs: [], sources: {}, reports: {}, rejections: {}, abandoned: [], containers: {}, rerun: null, cleanups: {} }
  for (const { event } of events) {
    if (event.type === 'VerificationRerunRequested') {
      const run = state.runs.find(run => run.request.id === event.request.afterRunId)
      if (state.rerun || !run || !executionBusy(run) || state.abandoned.includes(run.request.id)) throw new Error('Rerun requires a busy verification and an empty queue')
      state.rerun = { ...structuredClone(event.request), reason: null }
    } else if (event.type === 'VerificationRerunStarted' || event.type === 'VerificationRerunCancelled' || event.type === 'VerificationRerunDeferred') {
      const queued = state.rerun
      if (!queued || queued.id !== event.requestId) throw new Error('Rerun event has no matching pending request')
      if (event.type === 'VerificationRerunStarted') {
        const previous = state.runs.find(run => run.request.id === queued.afterRunId)
        const next = state.runs.at(-1)
        if (!previous || executionBusy(previous) && !state.abandoned.includes(previous.request.id) || !next || next.request.id !== event.runId || next.request.id === previous.request.id) throw new Error('Rerun started before its predecessor settled')
        state.rerun = null
      } else if (event.type === 'VerificationRerunCancelled') state.rerun = null
      else queued.reason = event.reason
    } else if (event.type === 'VerificationAbandonedCleanupRequested') {
      const run = state.runs.find(run => run.request.id === event.runId)
      projectVerificationCleanup(state.cleanups, event, { runId: event.runId, attemptId: event.attemptId,
        ownerAbandoned: state.abandoned.includes(event.runId) && run?.attempts.at(-1)?.id === event.attemptId,
        terminal: event.terminal, container: state.containers[event.attemptId] ?? null })
    } else if (event.type === 'VerificationCleanupRequested' || event.type === 'VerificationCleanupDeferred' || event.type === 'VerificationCleanupCompleted') {
      const run = state.runs.find(run => run.request.id === event.runId), attempt = run?.attempts.at(-1)
      projectVerificationCleanup(state.cleanups, event, {
        runId: event.runId, attemptId: event.attemptId, receiptHash: attempt?.id === event.attemptId ? attempt.receiptHash ?? null : null,
        artifactHash: state.reports[event.attemptId]?.artifactHash ?? null,
        classified: Boolean(state.reports[event.attemptId] || state.rejections[event.attemptId]),
        settled: Boolean(run && !executionBusy(run)), container: state.containers[event.attemptId] ?? null,
      })
    } else if (event.type === 'VerificationSourceCaptured') {
      if (state.sources[event.runId] || state.runs.some(run => run.request.id === event.runId)) throw new Error('Duplicate verification input version')
      state.sources[event.runId] = structuredClone(event.source)
    } else if (event.type === 'VerificationContainerPlanned' || event.type === 'VerificationContainerObserved') {
      const run = state.runs.find(run => run.request.id === event.runId)
      const attempt = run?.attempts.at(-1)
      if (!attempt || attempt.id !== event.attemptId || attempt.receiptHash) throw new Error('Verification container refers to an unavailable attempt')
      if (event.type === 'VerificationContainerPlanned') {
        if (event.name !== `srd-verification-${attempt.id}` || state.containers[attempt.id]) throw new Error('Duplicate or mismatched verification container intent')
        state.containers[attempt.id] = { name: event.name, id: null }
      } else {
        const container = state.containers[attempt.id]
        if (!container || container.id) throw new Error('Verification container was not planned or was already identified')
        container.id = event.containerId
      }
    } else if (event.type === 'VerificationRetryAuthorized') {
      const run = state.runs.find(run => run.request.id === event.runId)
      if (run?.outcome !== 'uncertain' || (run.attempts.at(-1)?.id ?? null) !== event.attemptId || state.abandoned.includes(event.runId)) throw new Error('Retry authorization does not refer to a new uncertain attempt')
      state.abandoned.push(event.runId)
    } else if (event.type === 'VerificationLaunchRejected') {
      const run = state.runs.find(run => run.request.id === event.runId)
      const attempt = run?.attempts.at(-1)
      if (!run || run.outcome !== 'running' || attempt?.id !== event.attemptId || attempt.identity || attempt.receiptHash) throw new Error('Launch rejection refers to a dispatched or completed verification')
      run.outcome = event.stopped ? 'stopped' : 'failed'; run.reason = event.reason; run.endedAt = event.at
    } else if (event.type === 'VerificationReportAccepted' || event.type === 'VerificationReportRejected') {
      const run = state.runs.find(run => run.request.id === event.runId)
      const attempt = run?.attempts.at(-1)
      if (!attempt?.receiptHash || attempt.id !== event.attemptId || state.reports[event.attemptId] || state.rejections[event.attemptId]) throw new Error('Verification report has no new accepted receipt')
      if (event.type === 'VerificationReportAccepted') state.reports[event.attemptId] = structuredClone(event)
      else state.rejections[event.attemptId] = event.reason
    } else {
      if (event.type === 'ExecutionQueued') {
        if (event.request.role !== 'verification' || !state.sources[event.request.id]) throw new Error('Verification request has no input version')
        if (state.runs.some(run => executionBusy(run) && !state.abandoned.includes(run.request.id))) throw new Error('Another verification needs reconciliation before a new request')
      }
      if (event.type === 'ExecutionAttemptRequested') {
        const source = state.sources[event.runId]
        if (!source || source.hash !== event.attempt.sourceHash || source.head !== event.attempt.head || event.attempt.spec.kind !== 'command') throw new Error('Verification attempt input mismatch')
      }
      if (event.type === 'ExecutionSettled') {
        if (!state.reports[event.attemptId] && !state.rejections[event.attemptId]) throw new Error('Verification settled without a classified report')
        const report = state.reports[event.attemptId]
        if (event.outcome === 'done' && (!report || report.commandError || !report.sourceUnchanged || report.report.totals.failed || report.report.totals.other)) throw new Error('Verification succeeded without a complete passing report for unchanged sources')
      }
      projectExecution(state.runs, event as ExecutionEvent)
    }
  }
  if (state.rerun && state.runs.some(run => run.request.id !== state.rerun!.afterRunId && executionBusy(run) && !state.abandoned.includes(run.request.id))) throw new Error('New verification did not consume its queued rerun')
  return state
}
export interface VerificationStream { events: VerificationEnvelope[]; bytes: string; version: string; projection: VerificationProjection }
export const VERIFICATION_EVENTS_FILE = '.spec-review/verification.events.jsonl'
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
export async function readVerificationStream(cwd: string): Promise<VerificationStream> {
  const bytes = await readFile(path.join(cwd, VERIFICATION_EVENTS_FILE), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
  const events: VerificationEnvelope[] = []
  const ids = new Set<string>()
  for (const line of bytes.split('\n').filter(Boolean)) {
    const envelope = Envelope.parse(JSON.parse(line))
    if (envelope.sequence !== events.length + 1 || events.length && envelope.stream !== events[0]!.stream || ids.has(envelope.id)) throw new Error('Invalid verification stream sequence or identity')
    ids.add(envelope.id); events.push(envelope)
  }
  return { events, bytes, version: hash(bytes), projection: projectVerification(events) }
}
async function runtimeDirectory(cwd: string): Promise<string> {
  const root = await realpath(cwd)
  const directory = path.join(root, '.spec-review')
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe verification runtime directory')
  return directory
}
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await rename(tmp, file)
  } finally { await rm(tmp, { force: true }) }
}
// A command's entire event batch is validated before the authoritative file changes.
// Rebuilding the JSON projection never launches commands or accepts a new result.
export async function updateVerification<T>(cwd: string, decide: (stream: VerificationStream) => Promise<{ events: readonly VerificationEvent[]; value: T }> | { events: readonly VerificationEvent[]; value: T }): Promise<T> {
  const directory = await runtimeDirectory(cwd)
  return withReviewLock(path.join(directory, 'verification.events.jsonl'), async () => {
    const previous = await readVerificationStream(cwd)
    const decision = await decide(previous)
    const command = randomUUID(), stream = previous.events[0]?.stream ?? randomUUID(), at = new Date().toISOString()
    const batch = decision.events.map((event, index) => Envelope.parse({ version: 1, stream, sequence: previous.events.length + index + 1, id: randomUUID(), command, at, event }))
    const events = [...previous.events, ...batch]
    const projection = projectVerification(events)
    if ((await readVerificationStream(cwd)).version !== previous.version) throw new HttpError(409, 'verification_conflict', 'Verification history changed; retry the command')
    if (batch.length) await atomicWrite(path.join(cwd, VERIFICATION_EVENTS_FILE), previous.bytes + (previous.bytes && !previous.bytes.endsWith('\n') ? '\n' : '') + batch.map(event => JSON.stringify(event) + '\n').join(''))
    await atomicWrite(path.join(directory, 'verification.json'), JSON.stringify(projection))
    return decision.value
  })
}
