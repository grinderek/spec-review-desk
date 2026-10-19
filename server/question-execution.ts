import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { selectAgent } from './agent-routing.ts'
import { type Config } from './config.ts'
import { isMissingSession, type CodexOutcome } from './codex.ts'
import { decideOwnerDecision } from './decision-commands.ts'
import { decisionsFromReply } from './decision-model.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { decideDiscussion } from './discussion-commands.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded } from './git.ts'
import { type ExecutionAttempt, type ExecutionRun } from './execution-model.ts'
import { captureExecutionBoundary, observeAttempt, requireAttemptInactive, stopLocalAttempt, type AttemptObservation } from './execution-receipts.ts'
import { allScenarios, loadChangeView } from './change-view.ts'
import { buildQuestionPrompt } from './prompt.ts'
import { AGENT_REPLY_SCHEMA_ARG, retryPrompt } from './protocol.ts'
import { anchorText, checkReply, QUESTION_TOOLS, reviewFiles, vetPatch, type CheckedReply } from './questions.ts'
import { acceptedReceipt, assertNoApplyExecution, executionHead, executionRun, newAttempt, ReviewExecutionTransport, sourceHash, withExecutionLock } from './review-execution.ts'
import { findThread, readReview, recordReviewEvents, type DecisionRecord, type Message, type ReviewDomainEvent } from './review-store.ts'
import { withDetachedReviewLocks } from './review-lock.ts'

export interface QuestionDeps { config: Config; bus: EventBus; now?: () => Date; environment?: () => NodeJS.ProcessEnv }
type Receipt = Extract<AttemptObservation, { kind: 'receipt' }>
export class QuestionService {
  #queues = new Map<string, Promise<void>>()
  #pending = new Map<string, number>()
  #transport: ReviewExecutionTransport
  constructor(private deps: QuestionDeps) { this.#transport = new ReviewExecutionTransport(deps.bus, (wt, ref, runId, receipt) => this.#accept(wt, ref, runId, receipt), deps.config) }
  queued(dir: string): number { return this.#pending.get(dir) ?? 0 }
  idle(dir: string): Promise<void> { return this.#queues.get(dir) ?? Promise.resolve() }
  settled(runId: string): Promise<void> { return this.#transport.settled(runId) }
  ask(wt: WorktreeInfo, ref: ChangeRef, _threadId: string): Promise<void> {
    // Every wake-up chains a drain, including one arriving as the previous drain is ending.
    // The durable queue decides which work remains; the in-memory chain cannot lose a wake-up.
    const current = this.#queues.get(ref.dir) ?? Promise.resolve()
    const follow = withDetachedReviewLocks(() => current.catch(error => console.error(error)).then(() => this.#drain(wt, ref)).catch(error => console.error(error)).finally(() => {
      if (this.#queues.get(ref.dir) === follow) this.#queues.delete(ref.dir)
      this.#pending.delete(ref.dir)
    }))
    this.#queues.set(ref.dir, follow); return follow
  }
  async #drain(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
    for (;;) {
      const doc = await readReview(ref.dir)
      const pending = doc.executions.filter(run => run.request.role === 'reviewer' && ['queued', 'running', 'uncertain'].includes(run.outcome))
      this.#pending.set(ref.dir, pending.length)
      if (pending.some(run => run.outcome === 'uncertain')) return
      const running = pending.find(run => run.outcome === 'running')
      if (running) {
        await this.#transport.settled(running.request.id)
        if (executionRun((await readReview(ref.dir)).executions, running.request.id).outcome === 'running') return
        continue
      }
      const run = pending.find(run => run.outcome === 'queued')
      if (!run) return
      await this.#start(wt, ref, run.request.id, 'initial')
      await this.#transport.settled(run.request.id)
    }
  }
  async prepareAttempt(wt: WorktreeInfo, ref: ChangeRef, run: ExecutionRun, cause: ExecutionAttempt['cause'], promptOverride?: string, sessionOverride?: string): Promise<ExecutionAttempt> {
    const view = await loadChangeView(wt, ref, { withCommits: false })
    const thread = findThread(view.review, run.request.threadId!)
    const previous = run.attempts.at(-1)
    const prompt = promptOverride ?? buildQuestionPrompt({ changeName: view.name, relDir: view.relDir,
      anchor: { kind: thread.anchor, ref: thread.ref, text: anchorText(view, thread.anchor, thread.ref) },
      messages: thread.messages.slice(0, run.request.messageCount), files: reviewFiles(view), today: new Date().toISOString().slice(0, 10),
      decisions: view.review.decisions, scenarioKeys: allScenarios(view).map(scenario => scenario.key) })
    const routing = previous?.routing ?? await selectAgent(this.deps.config, 'reviewer', prompt)
    if (!routing) throw new Error('A reviewer execution requires agent routing')
    const stored = sessionOverride ?? (cause === 'initial' ? view.review.agent_session : previous?.session ?? view.review.agent_session)
    return newAttempt({ cause, processBoundary: await captureExecutionBoundary(), head: await executionHead(wt.path), sourceHash: sourceHash({ prompt, scenarios: allScenarios(view).map(({ key, hash }) => ({ key, hash })) }),
      decisions: view.review.decisions, routing, spec: { kind: 'agent', bin: this.deps.config.codexBin, cwd: wt.path, sessionId: stored || randomUUID(),
        resume: Boolean(stored) && cause !== 'missing-session', model: routing.model, reasoningEffort: routing.reasoningEffort,
        allowedTools: QUESTION_TOOLS.allowed, disallowedTools: QUESTION_TOOLS.disallowed, permissionMode: 'default',
        appendSystemPrompt: await readFile(new URL('./prompts/reviewer.md', import.meta.url), 'utf8'), jsonSchema: AGENT_REPLY_SCHEMA_ARG, prompt } })
  }
  async #start(wt: WorktreeInfo, ref: ChangeRef, runId: string, cause: 'initial' | 'owner-resume'): Promise<void> {
    await withExecutionLock(wt, ref, async () => {
      await assertNoApplyExecution(wt.path, runId)
      await ensureExcluded(wt.path)
      let attempt!: ExecutionAttempt
      await recordReviewEvents(ref.dir, async doc => {
        const run = executionRun(doc.executions, runId)
        if (run.request.role !== 'reviewer' || run.outcome !== (cause === 'initial' ? 'queued' : 'uncertain')) throw new HttpError(409, 'run_not_waiting', 'This question is not waiting for execution')
        if (cause === 'owner-resume' && run.attempts.at(-1)) await requireAttemptInactive(wt.path, run.attempts.at(-1)!.id, run.attempts.at(-1)!.processBoundary)
        if (doc.executions.some(other => other.request.id !== runId && other.request.role === 'reviewer' && ['running', 'uncertain'].includes(other.outcome))) throw new HttpError(409, 'execution_pending', 'Another reviewer execution requires completion')
        attempt = await this.prepareAttempt(wt, ref, run, cause)
        if (attempt.spec.kind !== 'agent') throw new Error('Reviewer requires an agent attempt')
        return { events: [{ type: 'ExecutionAttemptRequested', runId, attempt }] }
      }, 'execution-command')
      this.deps.bus.publish(`thread:${(await readReview(ref.dir)).executions.find(run => run.request.id === runId)!.request.threadId}`, { type: 'running' })
      await this.#transport.dispatch(wt, ref, runId, attempt, this.deps.config.questionTimeoutMs, this.deps.environment?.())
    })
  }
  async #accept(wt: WorktreeInfo, ref: ChangeRef, runId: string, observed: Receipt): Promise<void> {
    if (observed.receipt.kind !== 'agent') throw new Error('Question received a command receipt')
    const receipt = observed.receipt
    let retry: ExecutionAttempt | undefined
    let threadId = ''
    await withExecutionLock(wt, ref, async () => {
      await recordReviewEvents(ref.dir, async doc => {
        const run = executionRun(doc.executions, runId), attempt = run.attempts.at(-1)!
        if (run.request.role !== 'reviewer') throw new HttpError(409, 'wrong_execution_role', 'This execution is not a question')
        const events: ReviewDomainEvent[] = acceptedReceipt(run, observed)
        if (!events.length) return { events: [] }
        threadId = run.request.threadId!
        const outcome = receipt.result
        const stopping = attempt.stopRequested || receipt.stopped
        const checked = outcome.ok && !stopping ? await checkReply(wt, ref, 'question', outcome) : null
        if (!stopping && isMissingSession(outcome) && attempt.cause !== 'missing-session') {
          retry = await this.prepareAttempt(wt, ref, run, 'missing-session', undefined, randomUUID())
        } else if (checked?.issues.length && !run.attempts.some(item => item.cause === 'validation-retry')) {
          retry = await this.prepareAttempt(wt, ref, run, 'validation-retry', retryPrompt(checked.issues), outcome.sessionId)
        }
        if (outcome.sessionId) events.push(...decideDiscussion(doc, { type: 'SetReviewAgentSession', session: outcome.sessionId }))
        if (retry) {
          events.push({ type: 'ExecutionAttemptRequested', runId, attempt: retry })
          return { events }
        }
        const note = run.attempts.some(item => item.cause === 'missing-session') ? 'New agent session - earlier context rebuilt from files' : null
        const composed = await this.#compose(wt, ref, run, stopping ? { ...outcome, ok: false, error: 'Stopped by the owner' } : outcome, checked, note, receipt.at)
        const settled = stopping ? 'stopped' : checked?.reply ? 'done' : 'failed'
        return { events: [...events,
          ...decideOwnerDecision(doc, { type: 'RaiseOwnerDecisions', decisions: composed.decisions }),
          ...decideDiscussion(doc, { type: 'AgentReply', threadId, message: composed.message, status: checked?.reply && !stopping ? 'answered' : 'open' }),
          { type: 'ExecutionSettled', runId, attemptId: attempt.id, outcome: settled, at: receipt.at }] }
      }, 'execution-command')
      if (retry) await this.#transport.dispatch(wt, ref, runId, retry, this.deps.config.questionTimeoutMs, this.deps.environment?.())
    })
    this.deps.bus.publish(`thread:${threadId}`, retry ? { type: 'reset' } : { type: 'done' })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }
  async #compose(wt: WorktreeInfo, ref: ChangeRef, run: ExecutionRun, outcome: CodexOutcome, checked: CheckedReply | null, note: string | null, at: string): Promise<{ message: Message; decisions: DecisionRecord[] }> {
    if (!outcome.ok || !checked) return { message: { role: 'agent', at, text: `The agent did not answer: ${outcome.error ?? 'unknown error'}`, note, patch: null }, decisions: [] }
    if (!checked.reply) return { message: { role: 'agent', at, text: 'The agent reply did not pass validation twice.', note, patch: null, invalid: { issues: checked.issues, raw: checked.raw } }, decisions: [] }
    const reply = checked.reply
    const decisions = decisionsFromReply(reply.decisions, { kind: 'thread', id: run.request.threadId! }, at)
    const originals = run.attempts.at(-1)!.decisions as DecisionRecord[]
    return { decisions, message: { role: 'agent', at, text: reply.answer, note, patch: reply.patch ? await vetPatch(wt.path, `openspec/changes/${ref.name}`, reply.patch) : null,
      ...(decisions.length ? { decision_ids: decisions.map(decision => decision.id) } : {}),
      ...(reply.resolves.length ? { resolves: reply.resolves, decision_bindings: reply.resolves.flatMap(id => {
        const decision = originals.find(decision => decision.id === id)
        return decision?.scope.kind === 'scenario' && decision.choice ? [{ decisionId: id, scope: decision.scope, choice: decision.choice }] : []
      }) } : {}) } }
  }
  async recover(wt: WorktreeInfo, ref: ChangeRef): Promise<void> { await this.#transport.recover(wt, ref, 'reviewer') }
  async resume(wt: WorktreeInfo, ref: ChangeRef, runId: string): Promise<void> {
    const run = executionRun((await readReview(ref.dir)).executions, runId), attempt = run.attempts.at(-1)
    if (run.request.role !== 'reviewer') throw new HttpError(409, 'wrong_execution_role', 'This execution is not a question')
    if (attempt) {
      const observation = await observeAttempt(wt.path, attempt.id)
      if (observation.kind === 'live') throw new HttpError(409, 'execution_running', 'The recorded attempt is still running')
      if (observation.kind === 'receipt' && !attempt.receiptHash) { await this.#transport.acceptReceipt(wt, ref, runId, observation); return }
    }
    await this.#start(wt, ref, runId, 'owner-resume')
    void withDetachedReviewLocks(() => this.#transport.settled(runId).then(() => this.ask(wt, ref, run.request.threadId!)))
  }
  async stop(wt: WorktreeInfo, ref: ChangeRef, runId: string): Promise<void> {
    let attemptId = ''
    let boundary: ExecutionAttempt['processBoundary']
    await recordReviewEvents(ref.dir, async doc => {
      const run = executionRun(doc.executions, runId), attempt = run.attempts.at(-1)
      if (run.request.role !== 'reviewer' || !attempt || !['running', 'uncertain'].includes(run.outcome)) throw new HttpError(409, 'run_not_running', 'This question has no active attempt')
      attemptId = attempt.id
      boundary = attempt.processBoundary
      return { events: attempt.stopRequested ? [] : [{ type: 'ExecutionStopRequested', runId, attemptId }] }
    }, 'execution-command')
    await stopLocalAttempt(wt.path, attemptId, boundary)
  }
}
