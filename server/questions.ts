import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { allScenarios, type ChangeView, findPhrase, findScenario, loadChangeView } from './change-view.ts'
import { type CodexEvent, type CodexOutcome, type CodexRunSpec, isMissingSession, runCodex } from './codex.ts'
import type { Config } from './config.ts'
import { addDecisions, decisionsFromReply } from './decision-model.ts'
import { DECISIONS_FILE } from './decisions-md.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import type { EventBus } from './events.ts'
import { checkPatch, disallowedPatchContent, patchPaths, touchedPaths, validatePatchPaths } from './patch.ts'
import { buildQuestionPrompt } from './prompt.ts'
import {
  AGENT_REPLY_SCHEMA_ARG, type AgentKind, type AgentReply, parseReply, type ReplyContext, retryPrompt, validateReply,
} from './protocol.ts'
import {
  appendMessage, type DecisionRecord, findThread, type Message, nowIso, type Patch, REVIEW_EVENTS_FILE, REVIEW_FILE, setAgentSession, setThreadStatus, type Thread,
  updateReview,
} from './review-store.ts'

export const QUESTION_TOOLS = { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch'] }
const REVIEWER_RULES = new URL('./prompts/reviewer.md', import.meta.url)
const NEW_SESSION_NOTE = 'new agent session — earlier context rebuilt from files'
const INVALID_TEXT = "The agent's reply did not pass validation twice; nothing was recorded from it."

export const ownerMessage = (text: string, at: Date = new Date()): Message => ({ role: 'owner', at: nowIso(at), text, note: null, patch: null })

export async function vetPatch(cwd: string, relDir: string, diff: string): Promise<Patch> {
  // Content checks first, and pure (no git call needed): a CRLF or binary/mode violation must
  // never even reach `git apply --numstat`, whose interpretation of such input isn't something
  // this code relies on.
  const contentError = disallowedPatchContent(diff)
  if (contentError) return { diff, state: 'stale', commit: null, error: contentError, files: patchPaths(diff) }
  const files = await touchedPaths(cwd, diff)
  const reviewFile = `${relDir}/${REVIEW_FILE}`
  const reviewEvents = `${relDir}/${REVIEW_EVENTS_FILE}`
  if (files.includes(reviewEvents)) return { diff, state: 'stale', commit: null, error: `a patch may not touch ${reviewEvents} — it is written by the Desk itself`, files }
  if (files.includes(reviewFile)) {
    return { diff, state: 'stale', commit: null, error: `a patch may not touch ${reviewFile} — it is written by the apply route itself`, files }
  }
  // Final review Minor 2: reviewer.md tells the question agent it may never touch decisions.md
  // (the Desk writes it, spec §6) — enforce that the same way review.yaml is enforced, so a
  // forged history entry can never reach it through a patch.
  const decisionsFile = `${relDir}/${DECISIONS_FILE}`
  if (files.includes(decisionsFile)) {
    return { diff, state: 'stale', commit: null, error: `a patch may not touch ${decisionsFile} — it is written by the Desk itself`, files }
  }
  const pathErrors = validatePatchPaths(files, relDir)
  if (pathErrors.length) return { diff, state: 'stale', commit: null, error: pathErrors.join('; '), files }
  const checkError = await checkPatch(cwd, diff)
  return { diff, state: checkError ? 'stale' : 'proposed', commit: null, error: checkError, files }
}

export function anchorText(view: ChangeView, anchor: Thread['anchor'], ref: string): string {
  if (anchor === 'scenario') return findScenario(view, ref)?.source ?? `(the scenario "${ref}" no longer exists)`
  if (anchor === 'phrase') {
    const phrase = findPhrase(view, ref)
    return phrase ? `${phrase.keyword ?? ''} \`${phrase.phrase}\` ${phrase.note}\nMeaning: ${phrase.meaning}`.trim() : `(the phrase "${ref}" no longer exists)`
  }
  return view.docs.proposal ?? '(no proposal.md)'
}

export function reviewFiles(view: ChangeView): string[] {
  return [
    ...view.features.map((f) => `${view.relDir}/${f.file}`),
    `${view.relDir}/features/NEW_STEPS.md`,
    'features/STEPS.md',
    `${view.relDir}/proposal.md`,
    `${view.relDir}/specs/`,
    `${view.relDir}/${DECISIONS_FILE}`,
  ]
}

export function replyContext(agent: AgentKind, view: ChangeView): ReplyContext {
  return { agent, scenarioKeys: allScenarios(view).map((s) => s.key), decisions: view.review.decisions }
}

export interface CheckedReply { reply: AgentReply | null; issues: string[]; raw: string }

export async function checkReply(wt: WorktreeInfo, ref: ChangeRef, agent: AgentKind, outcome: CodexOutcome): Promise<CheckedReply> {
  const raw = outcome.structured === null || outcome.structured === undefined ? outcome.text : JSON.stringify(outcome.structured, null, 2)
  const parsed = parseReply(outcome.structured)
  if (!parsed.reply) return { reply: null, issues: parsed.issues, raw }
  const issues = validateReply(parsed.reply, replyContext(agent, await loadChangeView(wt, ref, { withCommits: false })))
  return { reply: issues.length ? null : parsed.reply, issues, raw }
}

export interface QuestionDeps {
  config: Config
  bus: EventBus
  runCodex?: typeof runCodex
  now?: () => Date
}

export class QuestionService {
  #queues = new Map<string, Promise<void>>()
  #pending = new Map<string, number>()

  constructor(private readonly deps: QuestionDeps) {}

  queued(changeDir: string): number {
    return this.#pending.get(changeDir) ?? 0
  }

  idle(changeDir: string): Promise<void> {
    return this.#queues.get(changeDir) ?? Promise.resolve()
  }

  ask(wt: WorktreeInfo, ref: ChangeRef, threadId: string): Promise<void> {
    const topic = `thread:${threadId}`
    this.#pending.set(ref.dir, this.queued(ref.dir) + 1)
    this.deps.bus.publish(topic, { type: 'queued' })
    const next = this.idle(ref.dir)
      .then(() => this.#answer(wt, ref, threadId))
      .catch((error: unknown) => {
        console.error(error)
        this.deps.bus.publish(topic, { type: 'done', ok: false })
      })
      .finally(() => this.#pending.set(ref.dir, this.queued(ref.dir) - 1))
    this.#queues.set(ref.dir, next)
    return next
  }

  async #answer(wt: WorktreeInfo, ref: ChangeRef, threadId: string): Promise<void> {
    const { config, bus } = this.deps
    const exec = this.deps.runCodex ?? runCodex
    const now = this.deps.now ?? (() => new Date())
    const topic = `thread:${threadId}`
    const view = await loadChangeView(wt, ref, { withCommits: false })
    const thread = findThread(view.review, threadId)
    const prompt = buildQuestionPrompt({
      changeName: view.name,
      relDir: view.relDir,
      anchor: { kind: thread.anchor, ref: thread.ref, text: anchorText(view, thread.anchor, thread.ref) },
      messages: thread.messages,
      files: reviewFiles(view),
      today: nowIso(now()).slice(0, 10),
      decisions: view.review.decisions,
      scenarioKeys: allScenarios(view).map((s) => s.key),
    })
    const rules = await readFile(REVIEWER_RULES, 'utf8')
    const spec = (sessionId: string, resume: boolean, text: string): CodexRunSpec => ({
      bin: config.codexBin,
      cwd: wt.path,
      sessionId,
      resume,
      model: config.model,
      allowedTools: QUESTION_TOOLS.allowed,
      disallowedTools: QUESTION_TOOLS.disallowed,
      permissionMode: 'default',
      appendSystemPrompt: rules,
      jsonSchema: AGENT_REPLY_SCHEMA_ARG,
      prompt: text,
    })
    const options = {
      timeoutMs: config.questionTimeoutMs,
      onEvent: (e: CodexEvent) => {
        if (e.type === 'answer_delta') bus.publish(topic, { type: 'delta', text: e.text })
        if (e.type === 'answer_reset') bus.publish(topic, { type: 'reset' })
      },
    }
    bus.publish(topic, { type: 'running' })

    const stored = view.review.agent_session
    let session = stored ?? ''
    let outcome: CodexOutcome | null = stored ? await exec(spec(stored, true, prompt), options) : null
    let note: string | null = null
    if (!outcome || isMissingSession(outcome)) {
      if (outcome) {
        note = NEW_SESSION_NOTE
        bus.publish(topic, { type: 'reset' })
      }
      const fresh = randomUUID()
      session = fresh
      await updateReview(ref.dir, (doc) => setAgentSession(doc, fresh))
      outcome = await exec(spec(fresh, false, prompt), options)
    }
    let checked = outcome.ok ? await checkReply(wt, ref, 'question', outcome) : null
    if (checked && checked.issues.length) {
      // Spec §4: one retry in the same session; the UI drops the streamed invalid answer.
      bus.publish(topic, { type: 'reset' })
      outcome = await exec(spec(outcome.sessionId || session, true, retryPrompt(checked.issues)), options)
      checked = outcome.ok ? await checkReply(wt, ref, 'question', outcome) : null
    }

    if (outcome.sessionId) await updateReview(ref.dir, (doc) => setAgentSession(doc, outcome.sessionId))

    const { message, decisions } = await this.#compose(wt.path, view.relDir, threadId, outcome, checked, note, nowIso(now()))
    const ok = Boolean(checked?.reply)
    await updateReview(ref.dir, (doc) => setThreadStatus(appendMessage(addDecisions(doc, decisions), threadId, message), threadId, ok ? 'answered' : 'open'))
    bus.publish(topic, { type: 'done', ok })
    bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }

  async #compose(
    cwd: string,
    relDir: string,
    threadId: string,
    outcome: CodexOutcome,
    checked: CheckedReply | null,
    note: string | null,
    at: string,
  ): Promise<{ message: Message; decisions: DecisionRecord[] }> {
    if (!outcome.ok || !checked) {
      return { message: { role: 'agent', at, text: `The agent did not answer: ${outcome.error ?? 'unknown error'}`, note, patch: null }, decisions: [] }
    }
    if (!checked.reply) {
      return { message: { role: 'agent', at, text: INVALID_TEXT, note, patch: null, invalid: { issues: checked.issues, raw: checked.raw } }, decisions: [] }
    }
    const reply = checked.reply
    const decisions = decisionsFromReply(reply.decisions, { kind: 'thread', id: threadId }, at)
    const message: Message = {
      role: 'agent',
      at,
      text: reply.answer,
      note,
      patch: reply.patch ? await vetPatch(cwd, relDir, reply.patch) : null,
      ...(decisions.length ? { decision_ids: decisions.map((d) => d.id) } : {}),
      ...(reply.resolves.length ? { resolves: reply.resolves } : {}),
    }
    return { message, decisions }
  }
}
