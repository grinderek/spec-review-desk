import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RunnerProfile } from './config.ts'
import { executionBusy, type ExecutionAttempt, type ExecutionRun } from './execution-model.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { inspectVerificationContainer, stopVerificationContainer, verificationContainerName, type ContainerObservation, type VerificationContainer } from './verification-container.ts'
import { attemptDirectory, captureExecutionBoundary, observeAttempt, requireAttemptInactive, startLocalAttempt, stopLocalAttempt, type AttemptObservation } from './execution-receipts.ts'
import { HttpError } from './errors.ts'
import { withDetachedReviewLocks } from './review-lock.ts'
import { acceptVerificationReport } from './verification-report.ts'
import { readVerificationStream, updateVerification, type VerificationEvent, type VerificationProjection } from './verification-events.ts'
import { captureVerificationSource } from './verification-source.ts'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const pending = (projection: VerificationProjection): ExecutionRun | undefined => projection.runs.find(run => executionBusy(run) && !projection.abandoned.includes(run.request.id))
export interface VerificationExecutionDeps { timeoutMs?: number; changed?: (cwd: string) => void }

// Domain coordinator. Replay supplies state, the detached worker supplies process evidence,
// and only an explicit request authorizes a new command. Startup only observes existing work.
export class VerificationExecution {
  #drivers = new Map<string, Promise<void>>()
  constructor(private readonly deps: VerificationExecutionDeps = {}) {}

  async request(profile: RunnerProfile, explicit = true): Promise<string> {
    const cwd = profile.worktreePath
    await this.recover(cwd)
    const id = await withWorktreeAdmission(cwd, () => updateVerification(cwd, async stream => {
      const active = pending(stream.projection)
      const events: VerificationEvent[] = []
      if (active) {
        if (active.outcome !== 'uncertain') return { events, value: active.request.id }
        if (!explicit) throw new HttpError(409, 'verification_uncertain', 'The previous verification outcome is unknown; explicitly run it again after its processes stop')
        const attempt = active.attempts.at(-1)
        if (attempt) {
          try { await requireAttemptInactive(cwd, attempt.id, attempt.processBoundary) }
          catch (error) { throw new HttpError(409, 'verification_still_active', message(error)) }
          const container = stream.projection.containers[attempt.id]
          if (container) {
            await this.#containerInactive(cwd, active.request.id, attempt.id, container, false)
          }
        }
        events.push({ type: 'VerificationRetryAuthorized', runId: active.request.id, attemptId: attempt?.id ?? null })
      }
      await assertWorktreeAdmission(cwd, { operation: 'verification', runId: active?.request.id })
      const source = await captureVerificationSource(cwd)
      if (!source.contracts.length) throw new HttpError(409, 'empty_corpus', 'No executable contracts are available for verification')
      const runId = randomUUID(), attemptId = randomUUID(), at = new Date().toISOString()
      const resultFile = path.relative(cwd, path.join(attemptDirectory(cwd, attemptId), 'result.ndjson'))
      const environment = { DESK_RUN_ID: runId, DESK_ATTEMPT_ID: attemptId, DESK_SOURCE_HASH: source.hash, DESK_RESULT_FILE: resultFile }
      const command = profile.command.map(argument => argument.replaceAll('{resultFile}', resultFile))
      const compose = profile.execution !== 'local'
      if (compose && !profile.compose) throw new Error('Compose verification settings are missing')
      const containerName = verificationContainerName(attemptId)
      const args = compose ? ['compose', '-p', profile.compose!.project, ...profile.compose!.files.flatMap(file => ['-f', file]), 'run', '--no-deps', '--name', containerName, '--label', `dev.desk.attempt=${attemptId}`, '--label', `dev.desk.run=${runId}`, '-T', '--interactive=false', ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]), profile.compose!.service, ...command] : command.slice(1)
      const attempt: ExecutionAttempt = { id: attemptId, at, cause: 'initial', processBoundary: await captureExecutionBoundary(), head: source.head, sourceHash: source.hash, routing: null, decisions: [],
        spec: { kind: 'command', bin: compose ? 'docker' : command[0]!, cwd, args, environment, resultFile } }
      events.push({ type: 'VerificationSourceCaptured', runId, source },
        { type: 'ExecutionQueued', request: { id: runId, role: 'verification', threadId: null, messageCount: 0, at } },
        { type: 'ExecutionAttemptRequested', runId, attempt })
      if (compose) events.push({ type: 'VerificationContainerPlanned', runId, attemptId, name: containerName })
      return { events, value: runId }
    }))
    this.#changed(cwd)
    this.#drive(cwd, id, true)
    return id
  }

  async recover(cwd: string): Promise<void> {
    const stream = await readVerificationStream(cwd)
    const active = pending(stream.projection)
    if (!active) return
    // No dispatch during recovery, including the crash window before the first spawn.
    const live = await this.#observe(cwd, active.request.id)
    if (live) this.#drive(cwd, active.request.id, false)
  }

  async stop(cwd: string): Promise<void> {
    const attempt = await updateVerification(cwd, stream => {
      const active = pending(stream.projection), attempt = active?.attempts.at(-1)
      if (!active || !attempt) throw new HttpError(409, 'no_verification', 'No verification process is available to stop')
      return { events: attempt.stopRequested ? [] : [{ type: 'ExecutionStopRequested' as const, runId: active.request.id, attemptId: attempt.id }], value: attempt }
    })
    const attemptId = attempt.id
    await stopLocalAttempt(cwd, attemptId, attempt.processBoundary)
    const projection = (await readVerificationStream(cwd)).projection
    const container = projection.containers[attemptId]
    const run = projection.runs.find(item => item.attempts.some(attempt => attempt.id === attemptId))
    if (container && run) await stopVerificationContainer(cwd, run.request.id, attemptId, container)
    this.#changed(cwd)
  }

  async idle(cwd: string): Promise<void> {
    for (;;) { const driver = this.#drivers.get(cwd); if (!driver) return; await driver }
  }

  #drive(cwd: string, runId: string, dispatch: boolean): void {
    const previous = this.#drivers.get(cwd)
    if (previous) { void previous.then(() => this.#drive(cwd, runId, dispatch)); return }
    const driver = withDetachedReviewLocks(() => (async () => {
      if (dispatch) await this.#dispatch(cwd, runId)
      while (true) {
        const live = await this.#observe(cwd, runId)
        const stream = await readVerificationStream(cwd)
        const run = stream.projection.runs.find(item => item.request.id === runId)
        if (!run || !live || !executionBusy(run) || stream.projection.abandoned.includes(runId)) break
        await pause(100)
      }
    })().catch(async error => {
      await updateVerification(cwd, stream => {
        const run = stream.projection.runs.find(item => item.request.id === runId)
        return { events: run && executionBusy(run) && !stream.projection.abandoned.includes(runId) ? [{ type: 'ExecutionUncertain' as const, runId, attemptId: run.attempts.at(-1)?.id ?? null, reason: message(error) }] : [], value: undefined }
      }).catch(() => undefined)
      this.#changed(cwd)
    }).finally(() => { if (this.#drivers.get(cwd) === driver) this.#drivers.delete(cwd) }))
    this.#drivers.set(cwd, driver)
  }

  async #dispatch(cwd: string, runId: string): Promise<void> {
    await withWorktreeAdmission(cwd, () => updateVerification(cwd, async stream => {
      const run = stream.projection.runs.find(item => item.request.id === runId), attempt = run?.attempts.at(-1)
      if (!run || run.outcome !== 'running' || !attempt || attempt.identity || attempt.receiptHash || stream.projection.abandoned.includes(runId)) return { events: [], value: undefined }
      await assertWorktreeAdmission(cwd, { operation: 'verification', runId })
      // The same domain lock fences stale drivers through admission and external dispatch.
      if (attempt.stopRequested) return { events: [{ type: 'VerificationLaunchRejected' as const, runId, attemptId: attempt.id, at: new Date().toISOString(), reason: 'Stopped by the owner before dispatch', stopped: true }], value: undefined }
      if ((await captureVerificationSource(cwd)).hash !== attempt.sourceHash) return { events: [{ type: 'VerificationLaunchRejected' as const, runId, attemptId: attempt.id, at: new Date().toISOString(), reason: 'Sources changed before verification dispatch', stopped: false }], value: undefined }
      await startLocalAttempt(attempt, this.deps.timeoutMs ?? 900_000)
      return { events: [], value: undefined }
    }))
    this.#changed(cwd)
  }

  async #observe(cwd: string, runId: string): Promise<boolean> {
    const live = await updateVerification(cwd, async stream => {
      const run = stream.projection.runs.find(item => item.request.id === runId), attempt = run?.attempts.at(-1)
      if (!run || !executionBusy(run) || stream.projection.abandoned.includes(runId)) return { events: [], value: false }
      if (!attempt) return { events: [{ type: 'ExecutionUncertain' as const, runId, attemptId: null, reason: 'Verification request has no dispatched attempt' }], value: false }
      const container = stream.projection.containers[attempt.id]
      if (container && attempt.stopRequested) {
        try { await stopVerificationContainer(cwd, runId, attempt.id, container) }
        catch (error) { return { events: [{ type: 'ExecutionUncertain' as const, runId, attemptId: attempt.id, reason: message(error) }], value: false } }
      }
      const observed = await observeAttempt(cwd, attempt.id)
      if (observed.kind === 'uncertain') {
        if (run.outcome === 'uncertain' && run.reason === observed.reason) return { events: [], value: false }
        return { events: [{ type: 'ExecutionUncertain' as const, runId, attemptId: attempt.id, reason: observed.reason }], value: false }
      }
      if (observed.kind === 'live') {
        if (attempt.stopRequested) await stopLocalAttempt(cwd, attempt.id, attempt.processBoundary)
        return { events: attempt.identity ? [] : [{ type: 'ExecutionAttemptObserved' as const, runId, attemptId: attempt.id, identity: observed.identity }], value: true }
      }
      // A terminal receipt may precede worker exit by a few milliseconds. A surviving child
      // is still active work, so an explicit retry cannot overlap it or mark it successful.
      let inactivityError: unknown
      for (let i = 0; i < 10; i++) {
        try { await requireAttemptInactive(cwd, attempt.id, attempt.processBoundary); inactivityError = null; break } catch (error) { inactivityError = error; await pause(50) }
      }
      if (inactivityError) return { events: [{ type: 'ExecutionUncertain' as const, runId, attemptId: attempt.id, reason: message(inactivityError) }], value: false }
      try { return { events: await this.#classify(cwd, run, observed, stream.projection), value: false } }
      catch (error) { return { events: [{ type: 'ExecutionUncertain' as const, runId, attemptId: attempt.id, reason: message(error) }], value: false } }
    })
    this.#changed(cwd)
    return live
  }

  async #classify(cwd: string, run: ExecutionRun, observed: Extract<AttemptObservation, { kind: 'receipt' }>, projection: VerificationProjection): Promise<VerificationEvent[]> {
    const attempt = run.attempts.at(-1)!, runId = run.request.id
    const receipt = observed.receipt
    const events: VerificationEvent[] = []
    const container = projection.containers[attempt.id]
    if (container) {
      const missingAllowed = receipt.kind === 'command' && !receipt.stopped && !receipt.result.timedOut && receipt.result.code !== null && ![0, 130, 137, 143].includes(receipt.result.code)
      const observedContainer = await this.#containerInactive(cwd, runId, attempt.id, container, missingAllowed)
      if (observedContainer.kind !== 'missing' && !container.id) events.push({ type: 'VerificationContainerObserved', runId, attemptId: attempt.id, containerId: observedContainer.id })
      if (receipt.kind === 'command' && observedContainer.kind === 'terminal' && receipt.result.code !== observedContainer.exitCode) throw new Error('Verification receipt and container exit code differ')
    }
    if (!attempt.identity) events.push({ type: 'ExecutionAttemptObserved', runId, attemptId: attempt.id, identity: receipt.identity })
    events.push({ type: 'ExecutionReceiptAccepted', runId, attemptId: attempt.id, receiptHash: observed.hash, session: null })
    let outcome: 'done' | 'failed' | 'stopped' = 'failed'
    try {
      if (receipt.kind !== 'command') throw new Error('Verification received an agent receipt')
      const result = receipt.result
      if (result.artifactError) throw new Error(result.artifactError)
      if (!result.artifact) throw new Error('Verification command produced no report')
      const report = acceptVerificationReport(Buffer.from(result.artifact.content, 'base64'), { runId, attemptId: attempt.id, source: projection.sources[runId]! })
      const sourceUnchanged = (await captureVerificationSource(cwd)).hash === attempt.sourceHash
      const stopped = attempt.stopRequested || receipt.stopped
      const commandError = stopped ? 'Stopped by the owner' : result.timedOut ? 'Verification timed out' : result.error ?? (result.code !== 0 ? `Verification command exited with ${result.code ?? 'no exit code'}` : null)
      events.push({ type: 'VerificationReportAccepted', runId, attemptId: attempt.id, artifactHash: result.artifact.hash, sourceUnchanged, commandError, report })
      outcome = stopped ? 'stopped' : !commandError && sourceUnchanged && report.totals.failed === 0 && report.totals.other === 0 ? 'done' : 'failed'
    } catch (error) {
      events.push({ type: 'VerificationReportRejected', runId, attemptId: attempt.id, reason: message(error) })
      if (attempt.stopRequested || receipt.stopped) outcome = 'stopped'
    }
    events.push({ type: 'ExecutionSettled', runId, attemptId: attempt.id, outcome, at: receipt.at })
    return events
  }

  #changed(cwd: string): void { this.deps.changed?.(cwd) }

  async #containerInactive(cwd: string, runId: string, attemptId: string, container: VerificationContainer, missingAllowed: boolean): Promise<ContainerObservation> {
    const observed = await inspectVerificationContainer(cwd, runId, attemptId, container)
    if (observed.kind === 'live') throw new HttpError(409, 'verification_still_active', 'The previous verification container is still active')
    if (observed.kind === 'missing' && !missingAllowed) {
      // A missing container after an unconfirmed remote dispatch is an unknown outcome.
      // An API request may have outlived its client; absence alone cannot authorize retry.
      throw new HttpError(409, 'verification_container_uncertain', 'The previous verification container has no verifiable terminal state')
    }
    return observed
  }
}
