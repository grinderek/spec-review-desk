import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { loadChangeView } from './change-view.ts'
import { claudeArgs, type ClaudeEvent, type ClaudeRunSpec, parseStreamLine, type ResultEvent } from './claude.ts'
import type { Config } from './config.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded } from './git.ts'
import {
  addThread, appendMessage, type ApplyRun, findThread, type Message, newId, nowIso, readReview, type ReviewDoc, setThreadStatus,
  updateReview, upsertApplyRun,
} from './review-store.ts'

export const DEFAULT_APPLY_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
]
export const NEEDS_OWNER = /^NEEDS_OWNER:\s*(.+)$/m
const APPLY_RULES = new URL('./prompts/apply.md', import.meta.url)

export interface SpawnedProcess { pid: number; exited: Promise<number | null> }
export type SpawnDetached = (spec: ClaudeRunSpec, logFile: string) => SpawnedProcess

export const spawnDetached: SpawnDetached = (spec, logFile) => {
  const fd = openSync(logFile, 'a')
  const child = spawn(spec.bin, claudeArgs(spec), { cwd: spec.cwd, detached: true, stdio: ['pipe', fd, fd] })
  closeSync(fd)
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', () => resolve(null))
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

export function applyPrompt(changeName: string, onlyKeys: readonly string[]): string {
  const base = `/opsx:apply ${changeName}`
  if (onlyKeys.length === 0) return base
  return [
    base,
    '',
    'The owner approved changes to scenarios that are already implemented. The living corpus under',
    'features/ differs from the change for exactly these scenarios. Bring the corpus, the step',
    'definitions and the code in line with them, RED first:',
    ...onlyKeys.map((k) => `- ${k}`),
  ].join('\n')
}

export const readEvents = (text: string): ClaudeEvent[] =>
  text.split('\n').flatMap((line) => {
    const event = parseStreamLine(line)
    return event ? [event] : []
  })

export function outcomeOf(events: readonly ClaudeEvent[], stopping: boolean): { outcome: ApplyRun['outcome']; text: string } {
  const result = [...events].reverse().find((e): e is ResultEvent => e.type === 'result')
  const streamed = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
  const text = result?.text || streamed
  if (stopping) return { outcome: 'stopped', text: text || 'Stopped by the owner.' }
  if (!result || !result.ok) return { outcome: 'failed', text: text || 'The apply run ended without a result.' }
  return { outcome: NEEDS_OWNER.test(result.text) ? 'needs_owner' : 'done', text: result.text }
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

  settled(runId: string): Promise<void> {
    return this.#follows.get(runId) ?? Promise.resolve()
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
      const id = `r_${started.replace(/[-:.TZ]/g, '').slice(0, 14)}`
      const run: ApplyRun = { id, session: randomUUID(), pid: null, log: `.spec-review/runs/${id}.ndjson`, started_at: started, ended_at: null, outcome: 'running' }
      return await this.#launch(wt, ref, run, applyPrompt(ref.name, opts.onlyKeys ?? []), false)
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
      await this.#launch(wt, ref, { ...run, outcome: 'running', ended_at: null }, lastOwner?.text ?? 'Continue.', true)
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
      if (run.pid !== null && alive(run.pid)) {
        this.#active.set(wt.path, { runId: run.id, changeDir: ref.dir, pid: run.pid, stopping: false })
        this.#follow(wt, ref, run, this.#untilDead(run.pid), await sizeOf(path.join(wt.path, run.log)))
      } else {
        await this.#finalize(wt, ref, run)
      }
    }
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  async #launch(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, prompt: string, resume: boolean): Promise<ApplyRun> {
    const { config, bus } = this.deps
    await ensureExcluded(wt.path).catch(() => undefined)
    const logFile = path.join(wt.path, run.log)
    await mkdir(path.dirname(logFile), { recursive: true })
    const offset = await sizeOf(logFile)
    const spec: ClaudeRunSpec = {
      bin: config.claudeBin,
      cwd: wt.path,
      sessionId: run.session,
      resume,
      model: config.model,
      allowedTools: config.runners.find((p) => p.worktreePath === wt.path)?.applyAllowedTools ?? DEFAULT_APPLY_TOOLS,
      disallowedTools: [],
      permissionMode: 'acceptEdits',
      appendSystemPrompt: await readFile(APPLY_RULES, 'utf8'),
      prompt,
    }
    const proc = (this.deps.spawn ?? spawnDetached)(spec, logFile)
    const started: ApplyRun = { ...run, pid: proc.pid }
    this.#active.set(wt.path, { runId: run.id, changeDir: ref.dir, pid: proc.pid, stopping: false })
    await updateReview(ref.dir, (doc) => upsertApplyRun(doc, started))
    bus.publish(`run:${run.id}`, { type: 'started' })
    bus.publish('change', { worktreeId: wt.id, name: ref.name })
    this.#follow(wt, ref, started, proc.exited, offset)
    return started
  }

  #follow(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun, exited: Promise<unknown>, offset: number): void {
    const logFile = path.join(wt.path, run.log)
    let position = offset
    let partial = ''
    let draining: Promise<void> = Promise.resolve()
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
        const event = parseStreamLine(line)
        if (event) this.deps.bus.publish(`run:${run.id}`, { type: 'event', event })
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
        await this.#finalize(wt, ref, run)
      })
      .catch((error: unknown) => console.error(error))
    this.#follows.set(run.id, finished)
  }

  async #finalize(wt: WorktreeInfo, ref: ChangeRef, run: ApplyRun): Promise<void> {
    const text = await readFile(path.join(wt.path, run.log), 'utf8').catch(() => '')
    const current = this.#active.get(wt.path)
    const stopping = current?.runId === run.id && current.stopping
    const { outcome, text: summary } = outcomeOf(readEvents(text), stopping)
    const final: ApplyRun = { ...run, outcome, ended_at: nowIso(this.#now()) }
    await updateReview(ref.dir, (doc) => this.#record(doc, final, summary))
    if (current?.runId === run.id) this.#active.delete(wt.path)
    this.deps.bus.publish(`run:${run.id}`, { type: 'done', outcome })
    this.deps.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  }

  #record(doc: ReviewDoc, run: ApplyRun, summary: string): ReviewDoc {
    const withRun = upsertApplyRun(doc, run)
    const message: Message = { role: 'agent', at: nowIso(this.#now()), text: summary, note: `apply run ${run.id}: ${run.outcome}`, patch: null }
    const existing = withRun.threads.find((t) => t.anchor === 'apply' && t.ref === run.id)
    if (existing) return setThreadStatus(appendMessage(withRun, existing.id, message), existing.id, 'answered')
    if (run.outcome !== 'needs_owner') return withRun
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
