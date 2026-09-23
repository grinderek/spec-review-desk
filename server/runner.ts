import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { watch } from 'chokidar'
import type { RunnerProfile } from './config.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded, run, type RunOptions, type RunResult } from './git.ts'
import { type CorpusRun, parseRunMessages } from './run-messages.ts'

export const RESULT_FILE = '.spec-review/last-run.ndjson'
export type Exec = (cmd: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>

export interface RunnerState {
  profile: string
  worktreePath: string
  up: boolean | null
  running: boolean
  queued: boolean
  lastRunAt: string | null
  result: CorpusRun | null
  error: string | null
}

export interface RunnerDeps {
  profiles: readonly RunnerProfile[]
  bus: EventBus
  exec?: Exec
  debounceMs?: number
  runTimeoutMs?: number
  now?: () => Date
}

const IGNORED = ['.spec-review', 'tmp', 'log', 'node_modules', '.git']

export class RunnerService {
  #states = new Map<string, RunnerState>()
  #runs = new Map<string, Promise<void>>()
  #timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly deps: RunnerDeps) {
    for (const p of deps.profiles) {
      this.#states.set(p.worktreePath, { profile: p.name, worktreePath: p.worktreePath, up: null, running: false, queued: false, lastRunAt: null, result: null, error: null })
    }
  }

  profileFor(worktreePath: string): RunnerProfile | undefined {
    return this.deps.profiles.find((p) => p.worktreePath === worktreePath)
  }

  state(worktreePath: string): RunnerState | null {
    return this.#states.get(worktreePath) ?? null
  }

  idle(worktreePath: string): Promise<void> {
    return this.#runs.get(worktreePath) ?? Promise.resolve()
  }

  async refreshUp(worktreePath: string): Promise<boolean> {
    const p = this.#require(worktreePath)
    const r = await this.#exec('docker', this.#compose(p, ['ps', '--status', 'running', '-q', p.compose.service]), { cwd: worktreePath, allowFailure: true, timeoutMs: 30_000 })
    const up = r.code === 0 && r.stdout.trim() !== ''
    this.#set(worktreePath, { up })
    return up
  }

  async start(worktreePath: string): Promise<void> {
    const p = this.#require(worktreePath)
    await this.#exec('docker', this.#compose(p, ['up', '-d', p.compose.service]), { cwd: worktreePath, timeoutMs: 600_000 })
    await this.refreshUp(worktreePath)
  }

  async loadLast(worktreePath: string): Promise<void> {
    try {
      const result = parseRunMessages(await readFile(path.join(worktreePath, RESULT_FILE), 'utf8'))
      this.#set(worktreePath, { result, lastRunAt: result.finishedAt })
    } catch {
      // no previous run
    }
  }

  runNow(worktreePath: string): Promise<void> {
    this.#require(worktreePath)
    const current = this.#runs.get(worktreePath)
    if (current) {
      this.#set(worktreePath, { queued: true })
      return current
    }
    const loop = (async () => {
      this.#set(worktreePath, { running: true })
      try {
        do {
          this.#set(worktreePath, { queued: false })
          await this.#once(worktreePath)
        } while (this.state(worktreePath)?.queued)
      } finally {
        this.#runs.delete(worktreePath)
        this.#set(worktreePath, { running: false })
      }
    })()
    this.#runs.set(worktreePath, loop)
    return loop
  }

  schedule(worktreePath: string): void {
    const existing = this.#timers.get(worktreePath)
    if (existing) clearTimeout(existing)
    this.#timers.set(
      worktreePath,
      setTimeout(() => {
        this.#timers.delete(worktreePath)
        void this.runNow(worktreePath).catch((error: unknown) => console.error(error))
      }, this.deps.debounceMs ?? 2000),
    )
  }

  watch(): () => Promise<void> {
    const watchers = this.deps.profiles.map((p) => {
      const watcher = watch(p.watch.map((dir) => path.join(p.worktreePath, dir)), {
        ignoreInitial: true,
        ignored: (file: string) => file.endsWith('.tmp') || file.split(path.sep).some((part) => IGNORED.includes(part)),
      })
      watcher.on('all', () => this.schedule(p.worktreePath))
      return watcher
    })
    return async () => {
      for (const timer of this.#timers.values()) clearTimeout(timer)
      await Promise.all(watchers.map((w) => w.close()))
    }
  }

  async #once(worktreePath: string): Promise<void> {
    const p = this.#require(worktreePath)
    if (!(await this.refreshUp(worktreePath))) {
      this.#set(worktreePath, { error: 'runner off — start the container first' })
      return
    }
    await ensureExcluded(worktreePath).catch(() => undefined)
    await mkdir(path.join(worktreePath, '.spec-review'), { recursive: true })
    await rm(path.join(worktreePath, RESULT_FILE), { force: true })
    const r = await this.#exec('docker', this.#compose(p, ['exec', '-T', p.compose.service, ...p.command]), {
      cwd: worktreePath,
      allowFailure: true,
      timeoutMs: this.deps.runTimeoutMs ?? 900_000,
    })
    try {
      const result = parseRunMessages(await readFile(path.join(worktreePath, RESULT_FILE), 'utf8'))
      this.#set(worktreePath, { result, error: null, lastRunAt: (this.deps.now ?? (() => new Date()))().toISOString() })
    } catch {
      const tail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')
      this.#set(worktreePath, { error: `cucumber produced no result (exit ${r.code ?? 'none'}): ${tail}` })
    }
  }

  #exec(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
    return (this.deps.exec ?? run)(cmd, args, opts)
  }

  #compose(p: RunnerProfile, args: string[]): string[] {
    return ['compose', '-p', p.compose.project, ...p.compose.files.flatMap((f) => ['-f', f]), ...args]
  }

  #set(worktreePath: string, change: Partial<RunnerState>): void {
    const current = this.#states.get(worktreePath)
    if (!current) return
    this.#states.set(worktreePath, { ...current, ...change })
    this.deps.bus.publish('runner', { worktreePath })
  }

  #require(worktreePath: string): RunnerProfile {
    const profile = this.profileFor(worktreePath)
    if (!profile) throw new Error(`No runner profile for ${worktreePath}`)
    return profile
  }
}
