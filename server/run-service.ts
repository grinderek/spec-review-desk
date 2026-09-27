import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StructuredStream } from './answer-reader.ts'
import { readEvents } from './apply-outcome.ts'
import { type ClaudeRunSpec, parseStreamLine, type ResultEvent } from './claude.ts'
import type { Config } from './config.ts'
import { pendingBlocking, runDecisions } from './decision-model.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded } from './git.ts'
import { parseRunReply, REPLY_SCHEMA_ARGS, type RunReplies, validateRunReply } from './initiative-protocol.ts'
import { findRun, type InitiativeDoc, readInitiative, type RunKind, type RunRecord, updateInitiative, upsertRun } from './initiative-store.ts'
import { type InitiativeRef, sliceStatuses } from './initiatives.ts'
import { parseJsonObject, retryPrompt } from './protocol.ts'
import { newId, nowIso, readReview } from './review-store.ts'
import { assembleRoom, type RoomInput } from './room.ts'
import type { Sandbox } from './sandbox.ts'
import { agentTools, containerName, WORK_IN, WORK_OUT } from './sandbox-args.ts'
import { findSecrets, redactSecrets, ROTATE_HINT } from './secret-scan.ts'

// Spec B §4/§5: research, planner and author runs in the sandbox. One attempt = one container;
// a validation retry (A §4) or an owner resume is a new attempt in the same session.
export interface RunTarget { wt: WorktreeInfo; ini: InitiativeRef }
export interface RunPaths { runDir: string; room: string; out: string; sessions: string; log: string }
export interface RunContext {
  target: RunTarget
  run: RunRecord
  paths: RunPaths
  config: Config
  token: string | null
  at: string
  // Writes the run's outcome (and any other initiative.yaml change, in the same write); the
  // service cleans up and announces it once the finisher returns.
  record(outcome: RunRecord['outcome'], notes: string | null, problems?: string[], mutate?: (doc: InitiativeDoc) => InitiativeDoc): Promise<void>
  relaunch(patch: Partial<RunRecord>, prompt: string): Promise<void>
}
export type Finisher<K extends RunKind> = (ctx: RunContext, reply: RunReplies[K]) => Promise<void>
export type Finishers = { [K in RunKind]?: Finisher<K> }
export interface RunDeps { config: Config; bus: EventBus; sandbox: Sandbox; finishers: Finishers; now?: () => Date }

const RULES: Record<RunKind, URL> = {
  planner: new URL('./prompts/planner.md', import.meta.url),
  author: new URL('./prompts/author.md', import.meta.url),
  research: new URL('./prompts/research.md', import.meta.url),
}

export function runPaths(wt: WorktreeInfo, run: Pick<RunRecord, 'id' | 'log'>): RunPaths {
  const runDir = path.join(wt.path, '.spec-review', 'runs', run.id)
  return { runDir, room: path.join(runDir, 'room'), out: path.join(runDir, 'out'), sessions: path.join(runDir, 'sessions'), log: path.join(wt.path, run.log) }
}

export class InitiativeRunService {
  #follows = new Map<string, Promise<void>>()
  #starting = new Set<string>()

  constructor(private readonly deps: RunDeps) {}

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  settled = async (runId: string): Promise<void> => {
    for (let current = this.#follows.get(runId); current; ) {
      await current
      const next = this.#follows.get(runId)
      if (next === current) return
      current = next
    }
  }

  // One start at a time per key (e.g. one author per initiative): a double click never starts two.
  async exclusive<T>(key: string, busy: HttpError, fn: () => Promise<T>): Promise<T> {
    if (this.#starting.has(key)) throw busy
    this.#starting.add(key)
    try {
      return await fn()
    } finally {
      this.#starting.delete(key)
    }
  }

  async requireReady(): Promise<void> {
    const status = await this.deps.sandbox.status()
    if (!status.ready) throw new HttpError(409, 'sandbox_unavailable', `The sandbox is not ready: ${status.fixes.join(' · ')}`)
  }

  // Creates the run record, its directories and its room, then launches the first attempt.
  async begin(target: RunTarget, fields: Pick<RunRecord, 'kind'> & Partial<RunRecord>, prompt: string, room?: RoomInput['target']): Promise<RunRecord> {
    const id = newId('r')
    const run: RunRecord = {
      slice: null, topic: null, notes: null, ...fields,
      id, session: randomUUID(), container: containerName(id), log: `.spec-review/runs/${id}.ndjson`,
      started_at: nowIso(this.#now()), ended_at: null, outcome: 'running',
    }
    const paths = runPaths(target.wt, run)
    for (const dir of [paths.room, paths.out, paths.sessions]) await mkdir(dir, { recursive: true })
    // Ruling 6: the agent (uid 10001) writes its output and session store.
    await chmod(paths.out, 0o777)
    await chmod(paths.sessions, 0o777)
    await ensureExcluded(target.wt.path)
    const doc = await readInitiative(target.ini.dir)
    const statuses = await sliceStatuses(target.wt, doc)
    await assembleRoom(paths.room, { worktree: target.wt.path, initiativeDir: target.ini.dir, doc, kind: run.kind, statuses, target: room })
    await updateInitiative(target.ini.dir, (d) => upsertRun(d, run))
    this.#launch(target, run, prompt, false)
    this.#changed(target)
    return run
  }

  // Owner resume (spec B §4.4/§4.5): enabled once the run's blocking decisions are closed.
  async resumeRun(target: RunTarget, runId: string, patch: Partial<RunRecord>, prompt: (decisions: ReturnType<typeof runDecisions>) => string): Promise<void> {
    const run = findRun(await readInitiative(target.ini.dir), runId)
    if (run.outcome !== 'needs_owner') throw new HttpError(409, 'run_not_waiting', `Run ${runId} is ${run.outcome}, not waiting for the owner`)
    const decisions = runDecisions(await readReview(target.ini.dir), runId)
    const pending = pendingBlocking(decisions)
    if (pending.length) throw new HttpError(409, 'decisions_pending', `${pending.length} blocking decision(s) of this run are still open`)
    await this.requireReady()
    const next: RunRecord = { ...run, ...patch, outcome: 'running', ended_at: null, validation_retry: false }
    await updateInitiative(target.ini.dir, (d) => upsertRun(d, next))
    this.#launch(target, next, prompt(decisions), true)
    this.#changed(target)
  }

  async stop(target: RunTarget, runId: string): Promise<void> {
    const run = findRun(await readInitiative(target.ini.dir), runId)
    if (run.outcome !== 'running') throw new HttpError(409, 'run_not_running', `Run ${runId} is ${run.outcome}`)
    await this.deps.sandbox.stop(runId)
  }

  // Ruling 7: after a Desk restart, a run still marked running is marked failed.
  async failStale(target: RunTarget): Promise<void> {
    const doc = await readInitiative(target.ini.dir)
    for (const run of doc.runs.filter((r) => r.outcome === 'running' && !this.#follows.has(r.id))) {
      await this.deps.sandbox.stop(run.id).catch(() => undefined)
      await this.deps.sandbox.cleanup(run.id, runPaths(target.wt, run).runDir).catch((error: unknown) => console.error(error))
      const failed: RunRecord = { ...run, outcome: 'failed', ended_at: nowIso(this.#now()), notes: 'The Desk restarted while this run was running.' }
      await updateInitiative(target.ini.dir, (d) => upsertRun(d, failed))
    }
  }

  async log(target: RunTarget, runId: string): Promise<{ run: RunRecord; text: string }> {
    const run = findRun(await readInitiative(target.ini.dir), runId)
    const events = readEvents(await readFile(runPaths(target.wt, run).log, 'utf8').catch(() => ''))
    const narration = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
    const result = [...events].reverse().find((e): e is ResultEvent => e.type === 'result')
    const answer = result ? parseRunReply(run.kind, result.structured ?? parseJsonObject(result.text)).reply?.answer : undefined
    return { run, text: answer ? `${narration}${narration ? '\n\n' : ''}${answer}` : narration }
  }

  #changed(target: RunTarget): void {
    this.deps.bus.publish('initiative', { worktreeId: target.wt.id, name: target.ini.name })
  }

  #launch(target: RunTarget, run: RunRecord, prompt: string, resume: boolean): void {
    const follow = this.#attempt(target, run, prompt, resume).catch(async (error: unknown) => {
      console.error(error)
      await this.#final(target, run, 'failed', `The run broke: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.#follows.set(run.id, follow)
  }

  async #attempt(target: RunTarget, run: RunRecord, prompt: string, resume: boolean): Promise<void> {
    const { config, sandbox, bus } = this.deps
    const doc = await readInitiative(target.ini.dir)
    const webFetch = run.kind === 'research' && run.phase === 'read' && run.web_fetch === true
    const tools = agentTools(run.kind, webFetch)
    const claude: ClaudeRunSpec = {
      bin: 'claude', cwd: WORK_IN, sessionId: run.session, resume, model: config.model, allowedTools: tools.allowed,
      disallowedTools: tools.disallowed, permissionMode: tools.permissionMode, appendSystemPrompt: await readFile(RULES[run.kind], 'utf8'),
      jsonSchema: REPLY_SCHEMA_ARGS[run.kind], prompt,
    }
    const paths = runPaths(target.wt, run)
    await mkdir(path.dirname(paths.log), { recursive: true })
    const offset = await stat(paths.log).then((s) => s.size, () => 0)
    const stream = new StructuredStream()
    let writes: Promise<void> = Promise.resolve()
    const outcome = await sandbox.run(
      {
        runId: run.id, runDir: paths.runDir, room: paths.room, out: paths.out, sessions: paths.sessions,
        domains: webFetch ? doc.research.domains : [], claude, extraArgs: run.kind === 'author' ? ['--add-dir', WORK_OUT] : [],
      },
      {
        timeoutMs: config.sandbox.timeoutMs,
        onLine: (line) => {
          writes = writes.then(() => appendFile(paths.log, `${line}\n`))
          const event = parseStreamLine(line)
          if (!event) return
          bus.publish(`irun:${run.id}`, { type: 'event', event })
          for (const derived of stream.feed(event)) bus.publish(`irun:${run.id}`, { type: 'event', event: derived })
        },
      },
    )
    await writes
    const text = (await readFile(paths.log).catch(() => Buffer.alloc(0))).subarray(offset).toString('utf8')
    await this.#finish(target, run, paths, text, outcome)
  }

  async #finish(target: RunTarget, run: RunRecord, paths: RunPaths, text: string, outcome: Awaited<ReturnType<Sandbox['run']>>): Promise<void> {
    const token = await this.deps.sandbox.token()
    if (findSecrets(text, token).length) {
      await writeFile(paths.log, redactSecrets(await readFile(paths.log, 'utf8'), token))
      return this.#final(target, run, 'failed', ROTATE_HINT, ['a secret appeared in the agent output'])
    }
    if (outcome.stopped) return this.#final(target, run, 'stopped', 'Stopped by the owner.')
    if (outcome.timedOut) return this.#final(target, run, 'failed', `Timed out after ${Math.round(this.deps.config.sandbox.timeoutMs / 60_000)} min.`)
    const result = [...readEvents(text)].reverse().find((e): e is ResultEvent => e.type === 'result')
    if (!result?.ok) return this.#final(target, run, 'failed', outcome.error ?? result?.text ?? 'The agent ended without a result.')
    const parsed = parseRunReply(run.kind, result.structured ?? parseJsonObject(result.text))
    const issues = parsed.reply ? validateRunReply(run.kind, parsed.reply, { change: run.change }) : parsed.issues
    const ctx = this.#context(target, run, paths, token)
    if (issues.length) {
      if (!run.validation_retry) return ctx.relaunch({ validation_retry: true }, retryPrompt(issues))
      return this.#final(target, run, 'failed', 'The reply did not pass validation twice.', issues)
    }
    const finisher = this.deps.finishers[run.kind] as Finisher<typeof run.kind> | undefined
    if (!finisher) return this.#final(target, run, 'failed', `No handler for ${run.kind} runs.`)
    await finisher(ctx, parsed.reply!)
    await this.#settle(target, run)
  }

  #context(target: RunTarget, run: RunRecord, paths: RunPaths, token: string | null): RunContext {
    return {
      target, run, paths, token, config: this.deps.config, at: nowIso(this.#now()),
      record: (outcome, notes, problems, mutate) => this.#record(target, run, outcome, notes, problems, mutate),
      relaunch: async (patch, prompt) => {
        const next: RunRecord = { ...run, ...patch }
        await updateInitiative(target.ini.dir, (d) => upsertRun(d, next))
        this.#launch(target, next, prompt, true)
      },
    }
  }

  async #record(
    target: RunTarget, run: RunRecord, outcome: RunRecord['outcome'], notes: string | null, problems?: string[],
    mutate?: (doc: InitiativeDoc) => InitiativeDoc,
  ): Promise<void> {
    await updateInitiative(target.ini.dir, (d) => {
      const base = mutate ? mutate(d) : d
      const current = base.runs.find((r) => r.id === run.id) ?? run
      return upsertRun(base, { ...current, outcome, notes, ended_at: nowIso(this.#now()), ...(problems ? { problems } : {}) })
    })
  }

  // A run waiting for the owner keeps its room, output and session store for Resume; a relaunched
  // run (outcome running again) is not settled yet.
  async #settle(target: RunTarget, run: RunRecord): Promise<void> {
    const current = findRun(await readInitiative(target.ini.dir), run.id)
    if (current.outcome === 'running') return
    if (current.outcome !== 'needs_owner') await this.deps.sandbox.cleanup(run.id, runPaths(target.wt, run).runDir).catch((error: unknown) => console.error(error))
    this.deps.bus.publish(`irun:${run.id}`, { type: 'done', outcome: current.outcome })
    this.#changed(target)
  }

  async #final(target: RunTarget, run: RunRecord, outcome: RunRecord['outcome'], notes: string | null, problems?: string[]): Promise<void> {
    await this.#record(target, run, outcome, notes, problems)
    await this.#settle(target, run)
  }
}
