import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ChangeView, findPhrase, findScenario, loadChangeView } from './change-view.ts'
import { type ClaudeEvent, type ClaudeOutcome, type ClaudeRunSpec, isMissingSession, runClaude } from './claude.ts'
import type { Config } from './config.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import type { EventBus } from './events.ts'
import { checkPatch, extractPatch, patchPaths, validatePatchPaths } from './patch.ts'
import { buildQuestionPrompt } from './prompt.ts'
import {
  appendMessage, findThread, type Message, nowIso, type Patch, setAgentSession, setThreadStatus, type Thread, updateReview,
} from './review-store.ts'

export const QUESTION_TOOLS = { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['Edit', 'Write', 'Bash', 'NotebookEdit'] }
const REVIEWER_RULES = new URL('./prompts/reviewer.md', import.meta.url)
const NEW_SESSION_NOTE = 'new agent session — earlier context rebuilt from files'

export const ownerMessage = (text: string, at: Date = new Date()): Message => ({ role: 'owner', at: nowIso(at), text, note: null, patch: null })

export async function vetPatch(cwd: string, relDir: string, diff: string): Promise<Patch> {
  const pathErrors = validatePatchPaths(patchPaths(diff), relDir)
  if (pathErrors.length) return { diff, state: 'stale', commit: null, error: pathErrors.join('; ') }
  const checkError = await checkPatch(cwd, diff)
  return { diff, state: checkError ? 'stale' : 'proposed', commit: null, error: checkError }
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
  ]
}

export interface QuestionDeps {
  config: Config
  bus: EventBus
  runClaude?: typeof runClaude
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
    const exec = this.deps.runClaude ?? runClaude
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
    })
    const rules = await readFile(REVIEWER_RULES, 'utf8')
    const spec = (sessionId: string, resume: boolean): ClaudeRunSpec => ({
      bin: config.claudeBin,
      cwd: wt.path,
      sessionId,
      resume,
      model: config.model,
      allowedTools: QUESTION_TOOLS.allowed,
      disallowedTools: QUESTION_TOOLS.disallowed,
      permissionMode: 'default',
      appendSystemPrompt: rules,
      prompt,
    })
    const options = {
      timeoutMs: config.questionTimeoutMs,
      onEvent: (e: ClaudeEvent) => {
        if (e.type === 'delta') bus.publish(topic, { type: 'delta', text: e.text })
      },
    }
    bus.publish(topic, { type: 'running' })

    const stored = view.review.agent_session
    let outcome: ClaudeOutcome | null = stored ? await exec(spec(stored, true), options) : null
    let note: string | null = null
    if (!outcome || isMissingSession(outcome)) {
      if (outcome) {
        note = NEW_SESSION_NOTE
        bus.publish(topic, { type: 'reset' })
      }
      const fresh = randomUUID()
      await updateReview(ref.dir, (doc) => setAgentSession(doc, fresh))
      outcome = await exec(spec(fresh, false), options)
    }

    const message = await this.#agentMessage(wt.path, view.relDir, outcome, note, now())
    const ok = outcome.ok
    await updateReview(ref.dir, (doc) => setThreadStatus(appendMessage(doc, threadId, message), threadId, ok ? 'answered' : 'open'))
    bus.publish(topic, { type: 'done', ok })
    bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }

  async #agentMessage(cwd: string, relDir: string, outcome: ClaudeOutcome, note: string | null, at: Date): Promise<Message> {
    if (!outcome.ok) {
      return { role: 'agent', at: nowIso(at), text: `The agent did not answer: ${outcome.error ?? 'unknown error'}`, note, patch: null }
    }
    const diff = extractPatch(outcome.text)
    return { role: 'agent', at: nowIso(at), text: outcome.text, note, patch: diff ? await vetPatch(cwd, relDir, diff) : null }
  }
}
