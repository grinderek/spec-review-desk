import { randomUUID, createHash } from 'node:crypto'
import { type WorktreeInfo, type ChangeRef } from './discovery.ts'
import { HttpError } from './errors.ts'
import { executionBusy, type ExecutionRun, type ExecutionAttempt, type ExecutionEvent } from './execution-model.ts'
import { observeAttempt, startLocalAttempt, executionLog, stopLocalAttempt, requireAttemptInactive, type AttemptObservation } from './execution-receipts.ts'
import type { EventBus } from './events.ts'
import type { Config } from './config.ts'
import { appendAudit, auditId, estimateApiUsd } from './agent-usage.ts'
import { git } from './git.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { readReview, recordReviewEvents, withReviewLock } from './review-store.ts'
import { withDetachedReviewLocks } from './review-lock.ts'

export const sourceHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const executionHead = async (cwd: string): Promise<string> => (await git(cwd, ['rev-parse', 'HEAD'])).trim()
export const executionRun = (runs: ExecutionRun[], id: string): ExecutionRun => {
  const run = runs.find(run => run.request.id === id)
  if (!run) throw new HttpError(404, 'unknown_run', `No execution ${id}`)
  return run
}
export function withExecutionLock<T>(wt: WorktreeInfo, ref: ChangeRef, fn: () => Promise<T>): Promise<T> {
  return withWorktreeAdmission(wt.path, () => withReviewLock(ref.dir, fn))
}
export async function assertNoApplyExecution(cwd: string, except?: string): Promise<void> {
  return assertWorktreeAdmission(cwd, { operation: 'reviewer', runId: except })
}
export async function assertApplyAvailable(wt: WorktreeInfo, except?: string): Promise<void> {
  return assertWorktreeAdmission(wt.path, { operation: 'apply', runId: except })
}
export async function assertQuestionAvailable(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
  await assertNoApplyExecution(wt.path)
  if ((await readReview(ref.dir)).executions.some(run => run.request.role === 'reviewer' && run.outcome === 'uncertain')) {
    throw new HttpError(409, 'execution_pending', 'Recover the uncertain question before requesting more agent work')
  }
}
export class ReviewExecutionTransport {
  #follows = new Map<string, Promise<void>>()
  constructor(private bus: EventBus, private accept: (wt: WorktreeInfo, ref: ChangeRef, runId: string, receipt: Extract<AttemptObservation, { kind: 'receipt' }>) => Promise<void>, private config?: Config) {}
  async settled(id: string): Promise<void> {
    for (let follow = this.#follows.get(id); follow;) { await follow; const next = this.#follows.get(id); if (next === follow) return; follow = next }
  }
  async dispatch(wt: WorktreeInfo, ref: ChangeRef, runId: string, attempt: ExecutionAttempt, timeout: number, environment?: NodeJS.ProcessEnv): Promise<void> {
    return withExecutionLock(wt, ref, () => this.#dispatch(wt, ref, runId, attempt, timeout, environment))
  }
  async #dispatch(wt: WorktreeInfo, ref: ChangeRef, runId: string, attempt: ExecutionAttempt, timeout: number, environment?: NodeJS.ProcessEnv): Promise<void> {
    const run = executionRun((await readReview(ref.dir)).executions, runId)
    if (run.outcome !== 'running' || run.attempts.at(-1)?.id !== attempt.id || run.attempts.at(-1)?.receiptHash) return
    await assertWorktreeAdmission(wt.path, { operation: run.request.role === 'apply' ? 'apply' : 'reviewer', runId })
    await this.#audit(wt, ref, run, attempt, null)
    try { await startLocalAttempt(attempt, timeout, environment) }
    catch (error) {
      await this.uncertain(ref, runId, attempt.id, error instanceof Error ? error.message : String(error)); return
    }
    const observation = await observeAttempt(wt.path, attempt.id)
    if (observation.kind !== 'uncertain') await recordReviewEvents(ref.dir, async doc => {
      const current = executionRun(doc.executions, runId).attempts.at(-1)!
      return { events: current.identity || current.receiptHash ? [] : [{ type: 'ExecutionAttemptObserved', runId, attemptId: attempt.id,
        identity: observation.kind === 'live' ? observation.identity : observation.receipt.identity }] }
    }, 'execution-command')
    this.follow(wt, ref, runId, attempt.id)
  }
  follow(wt: WorktreeInfo, ref: ChangeRef, runId: string, attemptId: string): void {
    const promise = withDetachedReviewLocks(() => this.#follow(wt, ref, runId, attemptId).catch(async error => {
      console.error(error); await this.uncertain(ref, runId, attemptId, error instanceof Error ? error.message : String(error))
    }))
    this.#follows.set(runId, promise)
  }
  async acceptReceipt(wt: WorktreeInfo, ref: ChangeRef, runId: string, observed: Extract<AttemptObservation, { kind: 'receipt' }>): Promise<void> {
    const boundary = (await readReview(ref.dir)).executions.find(run => run.request.id === runId)?.attempts.find(attempt => attempt.id === observed.receipt.attemptId)?.processBoundary
    let failure: unknown
    for (let i = 0; i < 10; i++) {
      try { await requireAttemptInactive(wt.path, observed.receipt.attemptId, boundary); failure = null; break }
      catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    if (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      await this.uncertain(ref, runId, observed.receipt.attemptId, reason)
      throw new HttpError(409, 'execution_active', reason)
    }
    await this.accept(wt, ref, runId, observed)
  }
  async recover(wt: WorktreeInfo, ref: ChangeRef, role: ExecutionRun['request']['role']): Promise<void> {
    for (const run of (await readReview(ref.dir)).executions.filter(run => run.request.role === role && executionBusy(run))) {
      const attempt = run.attempts.at(-1)
      if (!attempt) { await this.uncertain(ref, run.request.id, null, 'The queued request was not dispatched. Resume it explicitly.'); continue }
      const observed = await observeAttempt(wt.path, attempt.id)
      if (observed.kind === 'receipt') { await this.#audit(wt, ref, run, attempt, observed); await this.acceptReceipt(wt, ref, run.request.id, observed) }
      else if (observed.kind === 'live') {
        if (attempt.stopRequested) await stopLocalAttempt(wt.path, attempt.id, attempt.processBoundary)
        this.follow(wt, ref, run.request.id, attempt.id)
      } else await this.uncertain(ref, run.request.id, attempt.id, observed.reason)
    }
  }
  async uncertain(ref: ChangeRef, runId: string, attemptId: string | null, reason: string): Promise<void> {
    await recordReviewEvents(ref.dir, async doc => {
      const run = executionRun(doc.executions, runId)
      if (!executionBusy(run) || run.attempts.at(-1)?.id !== (attemptId ?? undefined) || run.outcome === 'uncertain' && run.reason === reason) return { events: [] }
      return { events: [{ type: 'ExecutionUncertain', runId, attemptId, reason }] }
    }, 'execution-command')
  }
  async #follow(wt: WorktreeInfo, ref: ChangeRef, runId: string, attemptId: string): Promise<void> {
    let position = 0
    for (;;) {
      const current = executionRun((await readReview(ref.dir)).executions, runId)
      if (current.attempts.at(-1)?.id !== attemptId || current.attempts.at(-1)?.receiptHash) return
      const channel = current.request.role === 'reviewer' ? `thread:${current.request.threadId}` : `run:${runId}`
      const log = await executionLog(wt.path, attemptId)
      for (const event of log.slice(position)) {
        this.bus.publish(channel, current.request.role === 'reviewer' && event.type === 'delta' ? { type: 'delta', text: event.text } : { type: 'event', event })
      }
      position = log.length
      const observation = await observeAttempt(wt.path, attemptId)
      if (observation.kind === 'receipt') { await this.#audit(wt, ref, current, current.attempts.at(-1)!, observation); await this.acceptReceipt(wt, ref, runId, observation); return }
      if (observation.kind === 'uncertain') { await this.uncertain(ref, runId, attemptId, observation.reason); this.bus.publish('change', { worktreeId: wt.id, name: ref.name }); return }
      if (!current.attempts.at(-1)?.identity) await recordReviewEvents(ref.dir, async doc => {
        const attempt = executionRun(doc.executions, runId).attempts.at(-1)!
        return { events: attempt.identity || attempt.receiptHash ? [] : [{ type: 'ExecutionAttemptObserved', runId, attemptId, identity: observation.identity }] }
      }, 'execution-command')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  async #audit(wt: WorktreeInfo, ref: ChangeRef, run: ExecutionRun, attempt: ExecutionAttempt, observed: Extract<AttemptObservation, { kind: 'receipt' }> | null): Promise<void> {
    if (!this.config || !attempt.routing || attempt.spec.kind !== 'agent' || run.request.role === 'verification') return
    const base = { id: auditId(run.request.id, attempt.id), role: run.request.role, runId: run.request.id, worktreeId: wt.id, target: ref.name, resume: attempt.spec.resume, routing: attempt.routing }
    if (observed?.receipt.kind === 'command') return
    const result = observed?.receipt.result
    await appendAudit(this.config, result ? { ...base, type: 'completed', at: observed!.receipt.at,
      durationMs: Math.max(0, Date.parse(observed!.receipt.at) - Date.parse(attempt.at)), ok: result.ok && !observed!.receipt.stopped,
      usage: result.usage, toolCalls: result.toolCalls, estimatedApiUsd: estimateApiUsd(attempt.routing.model, result.usage), actualBilledUsd: null }
      : { ...base, type: 'started', at: attempt.at }).catch(error => console.error(error))
  }
}
export function acceptedReceipt(run: ExecutionRun, receipt: Extract<AttemptObservation, { kind: 'receipt' }>): ExecutionEvent[] {
  const attempt = run.attempts.at(-1)
  if (!attempt || attempt.id !== receipt.receipt.attemptId) throw new Error('Receipt refers to an outdated attempt')
  if (attempt.receiptHash) {
    if (attempt.receiptHash !== receipt.hash) throw new Error('Conflicting execution receipt')
    return []
  }
  return [{ type: 'ExecutionReceiptAccepted', runId: run.request.id, attemptId: attempt.id, receiptHash: receipt.hash,
    session: receipt.receipt.kind === 'agent' ? receipt.receipt.result.sessionId : null }]
}
export function newAttempt(fields: Omit<ExecutionAttempt, 'id' | 'at'>): ExecutionAttempt {
  return { ...fields, id: randomUUID(), at: new Date().toISOString() }
}
