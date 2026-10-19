import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { selectAgent } from './agent-routing.ts'
import { DEFAULT_APPLY_DENY, DEFAULT_APPLY_TOOLS, applyPrompt } from './apply.ts'
import { approvalCommitProven } from './approval-proof.ts'
import { allScenarios, loadChangeView, type ChangeView } from './change-view.ts'
import type { Config } from './config.ts'
import { decideOwnerDecision } from './decision-commands.ts'
import { decisionsFromReply, pendingBlocking, runDecisions } from './decision-model.ts'
import type { WorktreeInfo, ChangeRef } from './discovery.ts'
import { decideDiscussion } from './discussion-commands.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { queueExecution, type ExecutionAttempt, type ExecutionRun } from './execution-model.ts'
import { captureExecutionBoundary, executionLog, observeAttempt, requireAttemptInactive, stopLocalAttempt, type AttemptObservation } from './execution-receipts.ts'
import { ensureExcluded } from './git.ts'
import { buildResumePrompt } from './prompt.ts'
import { AGENT_REPLY_SCHEMA_ARG, parseReply, retryPrompt, validateReply, type AgentReply } from './protocol.ts'
import { replyContext } from './questions.ts'
import { acceptedReceipt, assertApplyAvailable, executionHead, executionRun, newAttempt, ReviewExecutionTransport, sourceHash, withExecutionLock } from './review-execution.ts'
import { findThread, newId, readReview, recordReviewEvents, type ApplyRun, type Message, type ReviewDomainEvent } from './review-store.ts'

export interface ApplyDeps { config: Config; bus: EventBus; pollMs?: number; now?: () => Date }
type Receipt = Extract<AttemptObservation, { kind: 'receipt' }>
const sources = (view: ChangeView): string => sourceHash({ contracts: view.contracts.map(({ key, hash, sourceHash }) => ({ key, hash, sourceHash })),
  phrases: view.phrases.map(({ key, hash }) => ({ key, hash })), metadata: view.metadata, validation: view.validation, docs: view.docs.proposal })
export class ApplyService {
  #active = new Set<string>()
  #transport: ReviewExecutionTransport
  constructor(private deps: ApplyDeps) { this.#transport = new ReviewExecutionTransport(deps.bus, (wt, ref, runId, receipt) => this.#accept(wt, ref, runId, receipt), deps.config) }
  active(cwd: string): boolean { return this.#active.has(cwd) }
  settled(id: string): Promise<void> { return this.#transport.settled(id) }
  async #build(wt: WorktreeInfo, ref: ChangeRef, run: ExecutionRun, prompt: string, cause: ExecutionAttempt['cause']): Promise<ExecutionAttempt> {
    const view = await loadChangeView(wt, ref, { withCommits: false })
    const previous = run.attempts.at(-1)
    const routing = previous?.routing ?? await selectAgent(this.deps.config, 'apply', prompt)
    if (!routing) throw new Error('Apply requires agent routing')
    const session = previous?.session ?? (previous?.spec.kind === 'agent' ? previous.spec.sessionId : randomUUID())
    return newAttempt({ cause, processBoundary: await captureExecutionBoundary(), head: await executionHead(wt.path), sourceHash: sources(view), decisions: view.review.decisions, routing,
      spec: { kind: 'agent', bin: this.deps.config.codexBin, cwd: wt.path, sessionId: session, resume: cause !== 'initial', model: routing.model,
        reasoningEffort: routing.reasoningEffort, allowedTools: this.deps.config.runners.find(profile => profile.worktreePath === wt.path)?.applyAllowedTools ?? DEFAULT_APPLY_TOOLS,
        disallowedTools: DEFAULT_APPLY_DENY, permissionMode: 'acceptEdits', appendSystemPrompt: await readFile(new URL('./prompts/apply.md', import.meta.url), 'utf8'), jsonSchema: AGENT_REPLY_SCHEMA_ARG, prompt } })
  }
  async #dispatch(wt: WorktreeInfo, ref: ChangeRef, runId: string, attempt: ExecutionAttempt): Promise<void> {
    const fresh = await loadChangeView(wt, ref, { withCommits: false })
    if (await executionHead(wt.path) !== attempt.head || sources(fresh) !== attempt.sourceHash) {
      await this.#transport.uncertain(ref, runId, attempt.id, 'Approved source facts changed before agent dispatch'); return
    }
    this.#active.add(wt.path)
    await this.#transport.dispatch(wt, ref, runId, attempt, this.deps.config.sandbox.timeoutMs)
    this.deps.bus.publish(`run:${runId}`, { type: 'started' })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }
  async start(wt: WorktreeInfo, ref: ChangeRef, opts: { onlyKeys?: readonly string[] } = {}): Promise<ApplyRun> {
    return withExecutionLock(wt, ref, async () => {
      await assertApplyAvailable(wt)
      await ensureExcluded(wt.path)
      const view = await loadChangeView(wt, ref, { withCommits: false })
      if (!view.review.approved_at) throw new HttpError(409, 'approval_not_recorded', 'Record the approval before running Apply')
      if (!view.readiness.ready) throw new HttpError(409, 'not_ready', `Not ready: ${view.readiness.reasons.join('; ')}`)
      if (!approvalCommitProven(view)) throw new HttpError(409, 'approval_not_committed', 'Finish committing the current owner approval before running Apply')
      const queued = queueExecution('apply')
      if (queued.type !== 'ExecutionQueued') throw new Error('Expected an execution request')
      const run: ExecutionRun = { request: queued.request, outcome: 'queued', endedAt: null, reason: null, attempts: [] }
      const attempt = await this.#build(wt, ref, run, applyPrompt(ref.name, view.relDir, opts.onlyKeys ?? [], view.review.decisions, allScenarios(view).map(scenario => scenario.key)), 'initial')
      await recordReviewEvents(ref.dir, async () => ({ events: [queued, { type: 'ExecutionAttemptRequested', runId: run.request.id, attempt }] }), 'execution-command')
      await this.#dispatch(wt, ref, run.request.id, attempt)
      return (await readReview(ref.dir)).apply_runs.find(item => item.id === run.request.id)!
    })
  }
  async resume(wt: WorktreeInfo, ref: ChangeRef, threadId: string, ownerText?: string): Promise<void> {
    const thread = findThread(await readReview(ref.dir), threadId)
    if (thread.anchor !== 'apply') throw new HttpError(409, 'not_apply_thread', 'This discussion is not an Apply run')
    await this.resumeWithDecisions(wt, ref, thread.ref, ownerText)
  }
  async resumeWithDecisions(wt: WorktreeInfo, ref: ChangeRef, runId: string, ownerText?: string): Promise<void> {
    const existing = executionRun((await readReview(ref.dir)).executions, runId), previous = existing.attempts.at(-1)
    if (existing.request.role !== 'apply') throw new HttpError(409, 'wrong_execution_role', 'This execution is not an Apply run')
    if (previous && !previous.receiptHash) {
      const observed = await observeAttempt(wt.path, previous.id)
      if (observed.kind === 'live') throw new HttpError(409, 'apply_running', 'The recorded Apply attempt is still running')
      if (observed.kind === 'receipt') { await this.#transport.acceptReceipt(wt, ref, runId, observed); return }
    }
    await withExecutionLock(wt, ref, async () => {
      await assertApplyAvailable(wt, runId)
      const view = await loadChangeView(wt, ref, { withCommits: false }), doc = view.review
      const run = executionRun(doc.executions, runId)
      if (run.request.role !== 'apply' || !['needs_owner', 'uncertain', 'stopped'].includes(run.outcome)) throw new HttpError(409, 'run_not_waiting', 'This Apply run is not waiting for an explicit resume')
      if (run.attempts.at(-1)) await requireAttemptInactive(wt.path, run.attempts.at(-1)!.id, run.attempts.at(-1)!.processBoundary)
      const decisions = runDecisions(doc, runId)
      if (pendingBlocking(decisions).length) throw new HttpError(409, 'decisions_pending', 'Record or dismiss the blocking decisions before resuming Apply')
      if (!doc.approved_at || !view.readiness.ready) throw new HttpError(409, 'not_ready', 'Current contracts require approval before Apply resumes')
      if (!approvalCommitProven(view)) throw new HttpError(409, 'approval_not_committed', 'Finish committing the current owner approval before Apply resumes')
      const prompt = ownerText ?? buildResumePrompt(decisions)
      const attempt = await this.#build(wt, ref, run, prompt, 'owner-resume')
      const thread = doc.threads.find(thread => thread.anchor === 'apply' && thread.ref === runId)
      await recordReviewEvents(ref.dir, async state => ({ events: [
        ...(thread ? decideDiscussion(state, { type: 'ReplyToDiscussion', threadId: thread.id, message: { role: 'owner', text: prompt, at: attempt.at, note: null, patch: null } }) : []),
        { type: 'ExecutionAttemptRequested', runId, attempt },
      ] }), 'execution-command')
      await this.#dispatch(wt, ref, runId, attempt)
    })
  }
  async #accept(wt: WorktreeInfo, ref: ChangeRef, runId: string, observed: Receipt): Promise<void> {
    if (observed.receipt.kind !== 'agent') throw new Error('Apply received a command receipt')
    const receipt = observed.receipt
    let retry: ExecutionAttempt | undefined, outcome = 'running'
    await withExecutionLock(wt, ref, async () => {
      await recordReviewEvents(ref.dir, async doc => {
        const run = executionRun(doc.executions, runId), attempt = run.attempts.at(-1)!
        if (run.request.role !== 'apply') throw new HttpError(409, 'wrong_execution_role', 'This execution is not an Apply run')
        const events = acceptedReceipt(run, observed)
        if (!events.length) return { events: [] }
        const stopping = attempt.stopRequested || receipt.stopped
        const parsed = receipt.result.ok && !stopping ? parseReply(receipt.result.structured) : null
        const view = await loadChangeView(wt, ref, { withCommits: false })
        const reply = parsed?.reply ?? null
        const issues = parsed ? reply ? validateReply(reply, replyContext('apply', view)) : parsed.issues : []
        const lastResume = run.attempts.findLastIndex(item => item.cause === 'owner-resume')
        if (issues.length && !stopping && !run.attempts.slice(Math.max(0, lastResume)).some(item => item.cause === 'validation-retry')) {
          retry = await this.#build(wt, ref, run, retryPrompt(issues), 'validation-retry')
          if (retry.spec.kind === 'agent') retry.spec.sessionId = receipt.result.sessionId || retry.spec.sessionId
          return { events: [...events, { type: 'ExecutionAttemptRequested', runId, attempt: retry }] }
        }
        const finalOutcome = stopping ? 'stopped' : !receipt.result.ok || issues.length || !reply ? 'failed'
          : reply.status === 'needs_owner' ? 'needs_owner' : reply.status === 'done' ? 'done' : 'failed'
        outcome = finalOutcome
        const valid = receipt.result.ok && !issues.length && !stopping ? reply : null
        const decisions = valid ? decisionsFromReply(valid.decisions, { kind: 'apply', run: runId }, receipt.at) : []
        const message: Message = { role: 'agent', at: receipt.at, text: stopping ? 'Stopped by the owner.' : valid?.answer ?? receipt.result.error ?? receipt.result.text,
          note: `Apply run ${runId}: ${finalOutcome}`, patch: null, ...(decisions.length ? { decision_ids: decisions.map(decision => decision.id) } : {}),
          ...(issues.length ? { invalid: { issues, raw: JSON.stringify(receipt.result.structured) } } : {}) }
        const thread = doc.threads.find(thread => thread.anchor === 'apply' && thread.ref === runId)
        const messages: ReviewDomainEvent[] = thread ? decideDiscussion(doc, { type: 'AgentReply', threadId: thread.id, message, status: 'answered' })
          : finalOutcome === 'needs_owner' || issues.length ? decideDiscussion(doc, { type: 'OpenDiscussion', thread: { id: newId('t'), anchor: 'apply', ref: runId, status: 'answered', messages: [message] } }) : []
        return { events: [...events, ...decideOwnerDecision(doc, { type: 'RaiseOwnerDecisions', decisions }), ...messages,
          { type: 'ExecutionSettled', runId, attemptId: attempt.id, outcome: finalOutcome, at: receipt.at }] }
      }, 'execution-command')
      if (retry) await this.#dispatch(wt, ref, runId, retry)
    })
    if (!retry) this.#active.delete(wt.path)
    this.deps.bus.publish(`run:${runId}`, retry ? { type: 'started' } : { type: 'done', outcome })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }
  async stop(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
    let attemptId = ''
    let boundary: ExecutionAttempt['processBoundary']
    await recordReviewEvents(ref.dir, async doc => {
      const run = doc.executions.find(run => run.request.role === 'apply' && ['running', 'uncertain'].includes(run.outcome))
      const attempt = run?.attempts.at(-1)
      if (!run || !attempt) throw new HttpError(409, 'not_running', 'No Apply attempt is active for this change')
      attemptId = attempt.id
      boundary = attempt.processBoundary
      return { events: attempt.stopRequested ? [] : [{ type: 'ExecutionStopRequested', runId: run.request.id, attemptId }] }
    }, 'execution-command')
    await stopLocalAttempt(wt.path, attemptId, boundary)
  }
  async reattach(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
    await this.#transport.recover(wt, ref, 'apply')
    if ((await readReview(ref.dir)).executions.some(run => run.request.role === 'apply' && ['running', 'uncertain'].includes(run.outcome))) this.#active.add(wt.path)
  }
  async log(wt: WorktreeInfo, ref: ChangeRef, id: string): Promise<{ run: ApplyRun; text: string }> {
    const doc = await readReview(ref.dir), execution = executionRun(doc.executions, id)
    const run = doc.apply_runs.find(run => run.id === id)
    if (!run) throw new HttpError(404, 'unknown_run', 'This execution is not an Apply run')
    const logs = await Promise.all(execution.attempts.map(attempt => executionLog(wt.path, attempt.id)))
    return { run, text: logs.flat().flatMap(event => event.type === 'delta' ? [event.text] : []).join('') }
  }
}
