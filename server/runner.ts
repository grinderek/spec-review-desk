import path from 'node:path'
import { watch } from 'chokidar'
import type { RunnerProfile } from './config.ts'
import type { EventBus } from './events.ts'
import type { ExecutionRun } from './execution-model.ts'
import { ensureExcluded, run, type RunOptions, type RunResult } from './git.ts'
import { HttpError } from './errors.ts'
import type { CorpusRun } from './run-messages.ts'
import { VerificationExecution } from './verification-execution.ts'
import { readVerificationStream, updateVerification } from './verification-events.ts'
import { captureVerificationSource } from './verification-source.ts'

export type Exec = (cmd: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>
export interface RunnerState {
  profile: string
  execution?: 'compose' | 'local'
  worktreePath: string
  up: boolean | null
  running: boolean
  queued: boolean
  lastRunAt: string | null
  result: CorpusRun | null
  error: string | null
  runId: string | null
  outcome: ExecutionRun['outcome'] | null
  sourceHash: string | null
  stale: boolean
}
export interface RunnerDeps {
  profiles: readonly RunnerProfile[]
  bus: EventBus
  exec?: Exec
  debounceMs?: number
  runTimeoutMs?: number
}
const IGNORED = ['.spec-review', 'tmp', 'log', 'node_modules', '.git']
export function isIgnoredWatchPath(worktreePath: string, file: string): boolean {
  const rel = path.relative(worktreePath, file)
  return rel.endsWith('.tmp') || rel.split(path.sep).some(part => IGNORED.includes(part))
}

export class RunnerService {
  #states = new Map<string, RunnerState>()
  #timers = new Map<string, NodeJS.Timeout>()
  #refreshes = new Map<string, Promise<void>>()
  readonly #execution: VerificationExecution
  constructor(private readonly deps: RunnerDeps) {
    this.#execution = new VerificationExecution({ timeoutMs: deps.runTimeoutMs, changed: cwd => {
      void this.refresh(cwd).catch(error => this.#set(cwd, { error: error instanceof Error ? error.message : String(error) }))
    } })
    for (const p of deps.profiles) this.#states.set(p.worktreePath, {
      profile: p.name, execution: p.execution ?? 'compose', worktreePath: p.worktreePath,
      up: null, running: false, queued: false, lastRunAt: null, result: null, error: null,
      runId: null, outcome: null, sourceHash: null, stale: false,
    })
  }
  profileFor(cwd: string): RunnerProfile | undefined { return this.deps.profiles.find(p => p.worktreePath === cwd) }
  state(cwd: string): RunnerState | null { return this.#states.get(cwd) ?? null }
  async idle(cwd: string): Promise<void> { await this.#execution.idle(cwd); await this.refresh(cwd) }

  async refreshUp(cwd: string): Promise<boolean> {
    const p = this.#require(cwd)
    if (p.execution === 'local') { this.#set(cwd, { up: true }); return true }
    const result = await this.#exec('docker', this.#compose(p, ['ps', '--status', 'running', '-q', p.compose!.service]), { cwd, allowFailure: true, timeoutMs: 30_000 })
    const up = result.code === 0 && result.stdout.trim() !== ''
    this.#set(cwd, { up }); return up
  }
  async start(cwd: string): Promise<void> {
    const p = this.#require(cwd)
    if (p.execution !== 'local') await this.#exec('docker', this.#compose(p, ['up', '-d', p.compose!.service]), { cwd, timeoutMs: 600_000 })
    await this.refreshUp(cwd)
  }
  async loadLast(cwd: string): Promise<void> {
    await updateVerification(cwd, () => ({ events: [], value: undefined }))
    await this.#execution.recover(cwd)
    await this.refresh(cwd)
  }
  async runNow(cwd: string, explicit = true): Promise<void> {
    const profile = this.#require(cwd)
    if (!(await this.refreshUp(cwd))) throw new HttpError(409, 'runner_off', 'Start the verification container first')
    await ensureExcluded(cwd)
    await this.#execution.request(profile, explicit)
    await this.refresh(cwd)
  }
  async stop(cwd: string): Promise<void> { this.#require(cwd); await this.#execution.stop(cwd); await this.refresh(cwd) }

  // Public observations replay the journal and compare input versions; they never dispatch work
  // or accept receipts. Startup reconciliation is a separate, explicit service operation.
  refresh(cwd: string): Promise<void> {
    const previous = this.#refreshes.get(cwd) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const stream = await readVerificationStream(cwd)
      const latest = stream.projection.runs.at(-1)
      if (!latest) return
      const attempt = latest.attempts.at(-1), accepted = attempt ? stream.projection.reports[attempt.id] : undefined
      let stale = accepted ? !accepted.sourceUnchanged : false
      let sourceError: string | null = null
      if (accepted) {
        try { stale ||= (await captureVerificationSource(cwd)).hash !== attempt!.sourceHash }
        catch (error) { stale = true; sourceError = error instanceof Error ? error.message : String(error) }
      }
      const rejection = attempt ? stream.projection.rejections[attempt.id] : undefined
      this.#set(cwd, {
        runId: latest.request.id, outcome: latest.outcome, sourceHash: attempt?.sourceHash ?? null, stale,
        running: latest.outcome === 'running', queued: latest.outcome === 'queued' || Boolean(stream.projection.rerun),
        lastRunAt: latest.endedAt, result: accepted?.report ?? null,
        error: stream.projection.rerun?.reason ?? Object.values(stream.projection.cleanups).find(intent => intent.status === 'blocked')?.reason ?? latest.reason ?? rejection ?? accepted?.commandError ?? sourceError ?? (stale ? 'Sources changed since this verification run' : null),
      })
    }).finally(() => { if (this.#refreshes.get(cwd) === next) this.#refreshes.delete(cwd) })
    this.#refreshes.set(cwd, next); return next
  }
  schedule(cwd: string): void {
    const previous = this.#timers.get(cwd)
    if (previous) clearTimeout(previous)
    if (this.state(cwd)?.result) this.#set(cwd, { stale: true })
    this.#timers.set(cwd, setTimeout(() => {
      this.#timers.delete(cwd)
      void this.runNow(cwd, false).catch(error => this.#set(cwd, { error: error instanceof Error ? error.message : String(error) }))
    }, this.deps.debounceMs ?? 2000))
  }
  watch(): () => Promise<void> {
    const watchers = this.deps.profiles.map(profile => {
      const watcher = watch(profile.watch.map(dir => path.join(profile.worktreePath, dir)), {
        ignoreInitial: true, ignored: (file: string) => isIgnoredWatchPath(profile.worktreePath, file),
      })
      watcher.on('all', () => this.schedule(profile.worktreePath)); return watcher
    })
    return async () => {
      for (const timer of this.#timers.values()) clearTimeout(timer)
      await Promise.all(watchers.map(watcher => watcher.close()))
    }
  }
  #exec(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> { return (this.deps.exec ?? run)(cmd, args, opts) }
  #compose(profile: RunnerProfile, args: string[]): string[] {
    if (!profile.compose) throw new Error('Compose settings are missing')
    return ['compose', '-p', profile.compose.project, ...profile.compose.files.flatMap(file => ['-f', file]), ...args]
  }
  #set(cwd: string, change: Partial<RunnerState>): void {
    const state = this.#states.get(cwd)
    if (!state) return
    const next = { ...state, ...change }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    this.#states.set(cwd, next); this.deps.bus.publish('runner', { worktreePath: cwd })
  }
  #require(cwd: string): RunnerProfile {
    const profile = this.profileFor(cwd)
    if (!profile) throw new Error(`No runner profile for ${cwd}`)
    return profile
  }
}
