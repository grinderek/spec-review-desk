import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { StructuredStream } from './answer-reader.ts'
import { outcomeOf, readEvents } from './apply-outcome.ts'
import { allScenarios, loadChangeView } from './change-view.ts'
import { codexArgs, type CodexRunSpec, CodexStream, prepareCodex } from './codex.ts'
import type { Config } from './config.ts'
import { addDecisions, decisionsFromReply, isActive, pendingBlocking, runDecisions } from './decision-model.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded } from './git.ts'
import { buildResumePrompt, decisionsSection, scenarioKeysSection } from './prompt.ts'
import { AGENT_REPLY_SCHEMA_ARG, retryPrompt, validateReply } from './protocol.ts'
import { replyContext } from './questions.ts'
import {
  addThread, appendMessage, type ApplyRun, type DecisionRecord, findThread, type Message, newId, nowIso, readReview, type ReviewDoc,
  setThreadStatus, updateReview, upsertApplyRun,
} from './review-store.ts'

export { NEEDS_OWNER, outcomeOf, readEvents } from './apply-outcome.ts'

export const DEFAULT_APPLY_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
]
// Denied command prefixes are removed before exposing the scoped MCP command tool.
export const DEFAULT_APPLY_DENY = [
  'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(rm:*)',
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'WebFetch', 'WebSearch',
]
const APPLY_RULES = new URL('./prompts/apply.md', import.meta.url)

export interface SpawnedProcess { pid: number; exited: Promise<number | null> }
export type SpawnDetached = (spec: CodexRunSpec, logFile: string) => SpawnedProcess

export const spawnDetached: SpawnDetached = (spec, logFile) => {
  const fd = openSync(logFile, 'a')
  const prepared = prepareCodex(spec)
  const child = spawn(spec.bin, codexArgs(prepared.spec), { cwd: spec.cwd, detached: true, stdio: ['pipe', fd, fd] })
  closeSync(fd)
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => { prepared.dispose(); resolve(code) })
    child.once('error', () => { prepared.dispose(); resolve(null) })
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(spec.prompt)
  child.unref()
  return { pid: child.pid ?? -1, exited }
}

export function isAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function applyPrompt(
  changeName: string,
  onlyKeys: readonly string[],
  decisions: readonly DecisionRecord[] = [],
  scenarioKeys: readonly string[] = [],
): string {
  const lines = [`Implement the owner-approved OpenSpec change "${changeName}".`, `Read openspec/changes/${changeName}/proposal.md, specs/ and features/ before making changes.`, "Follow the repository AGENTS.md and the OpenSpec apply skill under .agents/skills/ when present.", "Implement the approved scenarios, run the configured checks and commit the implementation."]
  if (onlyKeys.length) {
    lines.push(
      '',
      'The owner approved changes to scenarios that are already implemented. The living corpus under',
      'features/ differs from the change for exactly these scenarios. Bring the corpus, the step',
      'definitions and the code in line with them, RED first:',
      ...onlyKeys.map((k) => `- ${k}`),
    )
  }
  // Final review Important 1(a): the Apply prompt carried no scenario keys at all unless it was a
  // reapply, so a scenario-scoped `needs_owner` decision invented its own key.
  if (scenarioKeys.length) lines.push('', ...scenarioKeysSection(scenarioKeys))
  if (decisions.some(isActive)) lines.push('', ...decisionsSection(decisions))
  return lines.join('\n')
}

// review.yaml's `apply_runs[].log` is persisted data, not a server-only constant: a patch can
// touch review.yaml (§9), so a tampered or corrupted `log` field must never let a read or a
// tail escape `<worktree>/.spec-review/runs/`.
export function resolveRunLog(worktreePath: string, log: string): string {
  const runsDir = path.join(worktreePath, '.spec-review', 'runs')
  const resolved = path.resolve(worktreePath, log)
  if (resolved !== runsDir && !resolved.startsWith(`${runsDir}${path.sep}`)) {
    throw new HttpError(400, 'invalid_run_log', `Run log "${log}" is outside .spec-review/runs/`)
  }
  return resolved
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

interface Active { runId: string; changeDir: string; pid: number; stopping: boolean }

export interface ApplyDeps {
  config: Config
  bus: EventBus
  spawn?: SpawnDetached
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  pollMs?: number
  now?: () => Date
}

export class ApplyService {
  #active = new Map<string, Active>()
  #reserved = new Set<string>()
  #follows = new Map<string, Promise<void>>()

  constructor(private readonly deps: ApplyDeps) {}

  active(worktreePath: string): boolean {
    return this.#active.has(worktreePath) || this.#reserved.has(worktreePath)
  }

  async settled(runId: string): Promise<void> {
    // A validation retry relaunches the run from inside its own finalize, replacing this entry.
    for (let current = this.#follows.get(runId); current; ) {
      await current
      const next = this.#follows.get(runId)
      if (next === current) return
      current = next
    }
  }

  async start(wt: WorktreeInfo, ref: ChangeRef, opts: { onlyKeys?: readonly string[] } = {}): Promise<ApplyRun> {
    // Reserve synchronously (before the first await) so two near-simultaneous calls for the same
    // worktree cannot both pass this check and spawn two write agents in one working tree.
    if (this.active(wt.path)) throw new HttpError(409, 'apply_running', 'An Apply run is already active in this worktree')
    this.#reserved.add(wt.path)
    try {
      const view = await loadChangeView(wt, ref, { withCommits: false })
      if (!view.review.approved_at) throw new HttpError(409, 'approval_not_recorded', 'Record the approval before running Apply.')
      if (!view.readiness.ready) throw new HttpError(409, 'not_ready', `Not ready: ${view.readiness.reasons.join('; ')}`)
      const started = nowIso(this.#now())
      // The timestamp alone truncates to whole seconds, so two runs starting in the same second
      // (start immediately followed by settle+reapply, or a mocked clock in tests) would
      // otherwise collide and overwrite each other's log file and apply_runs entry.
      const id = `r_${started.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`
      const run: ApplyRun = {
        id, session: randomUUID(), pid: null, log: `.spec-review/runs/${id}.ndjson`, started_at: started, ended_at: null, outcome: 'running',
        resume_offset: 0,
      }
      const scenarioKeys = allScenarios(view).map((s) => s.key)
      return await this.#launch(wt, ref, run, applyPrompt(ref.name, opts.onlyKeys ?? [], view.review.decisions, scenarioKeys), false)
    } finally {
      // #launch sets #active for this path before its first await beyond the spawn call, so by
      // the time we get here on the success path #active already holds the run; on any failure
      // path (approval_not_recorded, not_ready, or a thrown error before the process is spawned)
      // #active was never set, and clearing the reservation is what releases the worktree.
      this.#reserved.delete(wt.path)
    }
  }

  async resume(wt: WorktreeInfo, ref: ChangeRef, threadId: string): Promise<void> {
    if (this.active(wt.path)) throw new HttpError(409, 'apply_running', 'An Apply run is already active in this worktree')
    this.#reserved.add(wt.path)
    try {
      const doc = await readReview(ref.dir)
      const thread = findThread(doc, threadId)
      const run = doc.apply_runs.find((r) => r.id === thread.ref)
      if (!run) throw new HttpError(404, 'unknown_run', `No apply run ${thread.ref}`)
      const lastOwner = [...thread.messages].reverse().find((m) => m.role === 'owner')
      await this.#launch(wt, ref, { ...run, outcome: 'running', ended_at: null, validation_retry: false }, lastOwner?.text ?? 'Continue.', true)
    } finally {
      this.#reserved.delete(wt.path)
    }
  }

  // Spec §8: enabled once every blocking decision of the run is recorded or dismissed.
  async resumeWithDecisions(wt: WorktreeInfo, ref: ChangeRef, runId: string): Promise<void> {
    if (this.active(wt.path)) throw new HttpError(409, 'apply_running', 'An Apply run is already active in this worktree')
    this.#reserved.add(wt.path)
    try {
      const doc = await readReview(ref.dir)
      const run = doc.apply_runs.find((r) => r.id === runId)
      if (!run) throw new HttpError(404, 'unknown_run', `No apply run ${runId}`)
      if (run.outcome !== 'needs_owner') throw new HttpError(409, 'run_not_waiting', `Apply run ${runId} is ${run.outcome}, not waiting for the owner`)
      const decisions = runDecisions(doc, runId)
      const pending = pendingBlocking(decisions)
      if (pending.length) {
        throw new HttpError(409, 'decisions_pending', `${pending.length} blocking decision(s) of this run are not recorded or dismissed yet`)
      }
      const prompt = buildResumePrompt(decisions)
      const thread = doc.threads.find((t) => t.anchor === 'apply' && t.ref === runId)
      if (thread) {
        const message: Message = { role: 'owner', at: nowIso(this.#now()), text: prompt, note: null, patch: null }
        await updateReview(ref.dir, (d) => setThreadStatus(appendMessage(d, thread.id, message), thread.id, 'open'))
      }
      await this.#launch(wt, ref, { ...run, outcome: 'running', ended_at: null, validation_retry: false }, prompt, true)
    } finally {
      this.#reserved.delete(wt.path)
    }
  }

  async stop(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
    const current = this.#active.get(wt.path)
    if (!current || current.changeDir !== ref.dir) throw new HttpError(409, 'not_running', 'No Apply run is active for this change')
    this.#active.set(wt.path, { ...current, stopping: true })
    if (current.pid <= 0) return
    const kill = this.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
    try {
      kill(-current.pid, 'SIGINT')
    } catch {
      try {
        kill(current.pid, 'SIGINT')
      } catch {
        // already gone
      }
    }
  }

  async reattach(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
    const alive = this.deps.alive ?? isAlive
    for (const run of (await readReview(ref.dir)).apply_runs.filter((r) => r.outcome === 'running')) {
      try {
        if (run.pid !== null && alive(run.pid)) {
          this.#active.set(wt.path, { runId: run.id, changeDir: ref.dir, pid: run.pid, stopping: false })
          this.#follow(wt, ref, run, this.#untilDead(run.pid), await sizeOf(resolveRunLog(wt.path, run.log)))
        } else {
          // The process died while the server was down. Finalize from THIS run's own
          // persisted resume_offset (not 0) — for a run that was a resume, the log still
          // holds the previous attempt's events before that offset, and reading from 0 would
          // resurface its stale result instead of correctly seeing "no result" for this attempt.
          await this.#finalize(wt, ref, run, run.resume_offset)
        }
      } catch (error) {
        // A single run's log field failing containment (§13: review.yaml is patchable) must
        // not abort reattaching every OTHER run in this worktree.
        await this.#failReattach(wt, ref, run, error)
      }
    }
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  async #launch(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, prompt: string, resume: boolean): Promise<ApplyRun> {
    const { config, bus } = this.deps
    await ensureExcluded(wt.path).catch(() => undefined)
    const logFile = resolveRunLog(wt.path, run.log)
    await mkdir(path.dirname(logFile), { recursive: true })
    const offset = await sizeOf(logFile)
    const spec: CodexRunSpec = {
      bin: config.codexBin,
      cwd: wt.path,
      sessionId: run.session,
      resume,
      model: config.model,
      allowedTools: config.runners.find((p) => p.worktreePath === wt.path)?.applyAllowedTools ?? DEFAULT_APPLY_TOOLS,
      disallowedTools: DEFAULT_APPLY_DENY,
      permissionMode: 'acceptEdits',
      appendSystemPrompt: await readFile(APPLY_RULES, 'utf8'),
      jsonSchema: AGENT_REPLY_SCHEMA_ARG,
      prompt,
    }
    const proc = (this.deps.spawn ?? spawnDetached)(spec, logFile)
    const started: ApplyRun = { ...run, pid: proc.pid, resume_offset: offset }
    this.#active.set(wt.path, { runId: run.id, changeDir: ref.dir, pid: proc.pid, stopping: false })
    await updateReview(ref.dir, (doc) => upsertApplyRun(doc, started))
    bus.publish(`run:${run.id}`, { type: 'started' })
    bus.publish('change', { worktreeId: wt.id, name: ref.name })
    this.#follow(wt, ref, started, proc.exited, offset)
    return started
  }

  #follow(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, exited: Promise<unknown>, offset: number): void {
    const logFile = resolveRunLog(wt.path, run.log)
    let position = offset
    let partial = ''
    let draining: Promise<void> = Promise.resolve()
    const structuredStream = new StructuredStream()
    const stream = new CodexStream()
    const drainOnce = async (): Promise<void> => {
      const size = await sizeOf(logFile)
      if (size <= position) return
      const handle = await open(logFile, 'r')
      try {
        const buffer = Buffer.alloc(size - position)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        position += bytesRead
        partial += buffer.subarray(0, bytesRead).toString()
      } finally {
        await handle.close()
      }
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        for (const event of stream.feed(line)) {
          this.deps.bus.publish(`run:${run.id}`, { type: 'event', event })
          for (const derived of structuredStream.feed(event)) this.deps.bus.publish(`run:${run.id}`, { type: 'event', event: derived })
        }
      }
    }
    const drain = (): Promise<void> => {
      draining = draining.then(drainOnce, drainOnce)
      return draining
    }
    const timer = setInterval(() => void drain(), this.deps.pollMs ?? 500)
    const finished = exited
      .then(async () => {
        clearInterval(timer)
        await drain()
        await this.#finalize(wt, ref, run, offset)
      })
      .catch((error: unknown) => console.error(error))
    this.#follows.set(run.id, finished)
  }

  // `offset` scopes the outcome to events written by THIS attempt (from `start`/`resume`, or
  // since a reattach). Without it, a resumed run that ends without producing its own `result`
  // event (stopped, crashed) would have its outcome/text taken from the PREVIOUS attempt's
  // result — e.g. resurfacing a stale `needs_owner` after the owner already answered it.
  async #finalize(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, offset = 0): Promise<void> {
    const buffer = await readFile(resolveRunLog(wt.path, run.log)).catch(() => Buffer.alloc(0))
    const text = buffer.subarray(offset).toString('utf8')
    const current = this.#active.get(wt.path)
    const stopping = current?.runId === run.id && current.stopping
    const events = readEvents(text)
    const session = events.findLast((e) => e.type === 'init')
    if (session?.type === 'init') run = { ...run, session: session.sessionId }
    const result = outcomeOf(events, stopping)
    const issues = result.reply
      ? validateReply(result.reply, replyContext('apply', await loadChangeView(wt, ref, { withCommits: false })))
      : result.issues
    if (issues.length && !stopping && !run.validation_retry) {
      // Spec §4: one retry in the same session. The relaunch replaces this run's follow entry.
      try {
        await this.#launch(wt, ref, { ...run, validation_retry: true }, retryPrompt(issues), true)
        return
      } catch (error) {
        console.error(error)
      }
    }
    const at = nowIso(this.#now())
    // Final review Important 2: issues surviving the retry (or a claim we never even validated,
    // e.g. an unparseable reply) mean the outcome is `failed` regardless of what the agent's reply
    // claimed — a `needs_owner` or `done` status from an invalid reply must not read as if it happened.
    const outcome = issues.length ? 'failed' : result.outcome
    const final: ApplyRun = { ...run, outcome, ended_at: at }
    const valid = issues.length === 0 ? result.reply : null
    const decisions = valid ? decisionsFromReply(valid.decisions, { kind: 'apply', run: run.id }, at) : []
    const message: Message = {
      role: 'agent',
      at,
      text: result.text,
      note: `apply run ${run.id}: ${final.outcome}`,
      patch: null,
      ...(decisions.length ? { decision_ids: decisions.map((d) => d.id) } : {}),
      ...(issues.length ? { invalid: { issues, raw: result.raw ?? result.text } } : {}),
    }
    await updateReview(ref.dir, (doc) => this.#record(addDecisions(doc, decisions), final, message))
    if (current?.runId === run.id) this.#active.delete(wt.path)
    this.deps.bus.publish(`run:${run.id}`, { type: 'done', outcome: final.outcome })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }

  async #failReattach(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    const at = nowIso(this.#now())
    const final: ApplyRun = { ...run, outcome: 'failed', ended_at: at }
    const message: Message = { role: 'agent', at, text: `The apply run could not be reattached: ${reason}`, note: `apply run ${run.id}: failed`, patch: null }
    await updateReview(ref.dir, (doc) => this.#record(doc, final, message))
    this.deps.bus.publish(`run:${run.id}`, { type: 'done', outcome: 'failed' })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }

  #record(doc: ReviewDoc, run: ApplyRun, message: Message): ReviewDoc {
    const withRun = upsertApplyRun(doc, run)
    const existing = withRun.threads.find((t) => t.anchor === 'apply' && t.ref === run.id)
    if (existing) return setThreadStatus(appendMessage(withRun, existing.id, message), existing.id, 'answered')
    if (run.outcome !== 'needs_owner' && !message.invalid) return withRun
    return addThread(withRun, { id: newId('t'), anchor: 'apply', ref: run.id, status: 'answered', messages: [message] })
  }

  #untilDead(pid: number): Promise<void> {
    const alive = this.deps.alive ?? isAlive
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!alive(pid)) {
          clearInterval(timer)
          resolve()
        }
      }, this.deps.pollMs ?? 500)
    })
  }
}
