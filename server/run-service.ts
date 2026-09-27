import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { StructuredStream } from './answer-reader.ts'
import { type ClaudeRunSpec, parseStreamLine, type ResultEvent } from './claude.ts'
import type { Config } from './config.ts'
import { pendingBlocking, runDecisions } from './decision-model.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { ensureExcluded } from './git.ts'
import { parseRunReply, REPLY_SCHEMA_ARGS, type RunReplies, validateRunReply } from './initiative-protocol.ts'
import { findRun, type InitiativeDoc, readInitiative, type RunKind, type RunRecord, runLogPath, updateInitiative, upsertRun } from './initiative-store.ts'
import { type InitiativeRef, sliceStatuses } from './initiatives.ts'
import { parseJsonObject, retryPrompt } from './protocol.ts'
import { newId, nowIso, readReview } from './review-store.ts'
import { assembleRoom, type RoomInput } from './room.ts'
import type { Sandbox } from './sandbox.ts'
import { agentTools, containerName, WORK_IN, WORK_OUT } from './sandbox-args.ts'
import { findSecretsInLine, maskDeep, redactSecrets, ROTATE_HINT, SecretDetector, SecretHoldback } from './secret-scan.ts'

// Spec B §4/§5: research, planner and author runs in the sandbox. One attempt = one container;
// a validation retry (A §4) or an owner resume is a new attempt in the same session.
export interface RunTarget { wt: WorktreeInfo; ini: InitiativeRef }
export interface RunPaths { runDir: string; room: string; out: string; sessions: string; log: string }
// The run's own persisted log format (review round 3, finding 1): only holdback-released, already-
// redacted text for the free-text channels (narration, thinking, the reconstructed answer), plus
// text-free structural markers — never a raw stream-json line, and never the result's raw text or
// structured payload (that lives only in memory for #finish, via the captured ResultEvent). Every
// entry is masked as a whole before it is written (review round 4). `attempt` and `answer_reset`
// mark where a new answer starts, so log() serves only the latest one.
type LogEntry =
  | { type: 'delta' | 'thinking' | 'answer'; text: string }
  | { type: 'attempt'; resume: boolean }
  | { type: 'answer_reset' }
  | { type: 'init'; sessionId: string }
  | { type: 'message_start' }
  | { type: 'tool_start'; index: number; name: string }
  | { type: 'result'; ok: boolean; sessionId: string; numTurns: number }
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
export interface ResumeGuard { key: string; busy: HttpError; check: (doc: InitiativeDoc) => void }
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

interface RawStreamLine { type?: string; event?: { type?: string; delta?: { type?: string; thinking?: unknown } } }

// claude.ts's ClaudeEvent model has no `thinking` variant (nothing outside this file ever needed
// it); extracting it locally, straight off the raw line, avoids widening that shared model just for
// a channel this file redacts and never surfaces anywhere else (review round 3).
function thinkingDeltaText(line: string): string | null {
  let parsed: RawStreamLine
  try {
    parsed = JSON.parse(line) as RawStreamLine
  } catch {
    return null
  }
  const inner = parsed.event
  return inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string'
    ? inner.delta.thinking
    : null
}

export class InitiativeRunService {
  #follows = new Map<string, Promise<void>>()
  #starting = new Set<string>()
  // One secret detector per run, shared by its attempts (review round 4, finding 3).
  #detectors = new Map<string, { token: string | null; detector: SecretDetector }>()

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
      id, session: randomUUID(), container: containerName(id), log: runLogPath(id),
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

  // Owner resume (spec B §4.4/§4.5): enabled once the run's blocking decisions are closed. One
  // resume per run at a time, and the needs_owner → running move is atomic in the initiative lock,
  // so a double click never starts a second attempt of the same run (final review I1) — with
  // DockerSandbox the loser's teardown would kill the winner's container and wipe its session.
  // `guard` adds a second exclusive key and a check on the locked document (one author per
  // initiative: a Resume never overlaps a Propose).
  resumeRun(
    target: RunTarget, runId: string, patch: Partial<RunRecord>, prompt: (decisions: ReturnType<typeof runDecisions>) => string,
    guard?: ResumeGuard,
  ): Promise<void> {
    const again = new HttpError(409, 'run_not_waiting', `Run ${runId} is already being resumed`)
    const resume = (): Promise<void> => this.#resume(target, runId, patch, prompt, guard?.check)
    return this.exclusive(`${target.ini.dir}#run:${runId}`, again, () => (guard ? this.exclusive(guard.key, guard.busy, resume) : resume()))
  }

  async #resume(
    target: RunTarget, runId: string, patch: Partial<RunRecord>, prompt: (decisions: ReturnType<typeof runDecisions>) => string,
    check?: (doc: InitiativeDoc) => void,
  ): Promise<void> {
    const waiting = (doc: InitiativeDoc): RunRecord => {
      const run = findRun(doc, runId)
      if (run.outcome !== 'needs_owner') throw new HttpError(409, 'run_not_waiting', `Run ${runId} is ${run.outcome}, not waiting for the owner`)
      check?.(doc)
      return run
    }
    waiting(await readInitiative(target.ini.dir))
    const decisions = runDecisions(await readReview(target.ini.dir), runId)
    const pending = pendingBlocking(decisions)
    if (pending.length) throw new HttpError(409, 'decisions_pending', `${pending.length} blocking decision(s) of this run are still open`)
    await this.requireReady()
    let next: RunRecord | null = null
    await updateInitiative(target.ini.dir, (d) => {
      next = { ...waiting(d), ...patch, outcome: 'running', ended_at: null, validation_retry: false }
      return upsertRun(d, next)
    })
    this.#launch(target, next!, prompt(decisions), true)
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

  // Reads the run's own persisted log (§ below: only holdback-released, already-redacted text and
  // text-free structural entries — never a raw delta line, review round 3). `redactSecrets` runs
  // once more over the assembled text as a defense-in-depth backstop (round 3, item 3).
  async log(target: RunTarget, runId: string): Promise<{ run: RunRecord; text: string }> {
    const run = findRun(await readInitiative(target.ini.dir), runId)
    const raw = await readFile(runPaths(target.wt, run).log, 'utf8').catch(() => '')
    const entries = raw.split('\n').flatMap((line): LogEntry[] => {
      if (!line) return []
      try {
        return [JSON.parse(line) as LogEntry]
      } catch {
        return []
      }
    })
    const narration = entries.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
    // Only the latest answer: a validation retry, an owner resume or an answer_reset starts a new
    // one (review round 4, finding 4); an attempt that streamed no answer keeps the previous one.
    const answers = entries.reduce<string[]>(
      (acc, e) => (e.type === 'attempt' || e.type === 'answer_reset' ? [...acc, ''] : e.type === 'answer' ? [...acc.slice(0, -1), `${acc.at(-1) ?? ''}${e.text}`] : acc),
      [''],
    )
    const answer = answers.findLast((a) => a !== '') ?? ''
    const text = answer ? `${narration}${narration ? '\n\n' : ''}${answer}` : narration
    return { run, text: redactSecrets(text, await this.deps.sandbox.token()) }
  }

  #detector(runId: string, token: string | null): SecretDetector {
    const existing = this.#detectors.get(runId)
    if (existing?.token === token) return existing.detector
    const detector = new SecretDetector(token)
    this.#detectors.set(runId, { token, detector })
    return detector
  }

  #changed(target: RunTarget): void {
    this.deps.bus.publish('initiative', { worktreeId: target.wt.id, name: target.ini.name })
  }

  #launch(target: RunTarget, run: RunRecord, prompt: string, resume: boolean): void {
    const follow = this.#attempt(target, run, prompt, resume).catch(async (error: unknown) => {
      console.error(error)
      await this.#final(target, run, 'failed', `The run broke: ${error instanceof Error ? error.message : String(error)}`).catch(
        (finalError: unknown) => console.error(finalError),
      )
    })
    this.#follows.set(run.id, follow)
  }

  async #attempt(target: RunTarget, run: RunRecord, prompt: string, resume: boolean): Promise<void> {
    const { config, sandbox, bus } = this.deps
    const doc = await readInitiative(target.ini.dir)
    const webFetch = run.kind === 'research' && run.phase === 'read' && run.web_fetch === true
    const tools = agentTools(run.kind, webFetch)
    const token = await sandbox.token()
    const claude: ClaudeRunSpec = {
      bin: 'claude', cwd: WORK_IN, sessionId: run.session, resume, model: config.model, allowedTools: tools.allowed,
      disallowedTools: tools.disallowed, permissionMode: tools.permissionMode, appendSystemPrompt: await readFile(RULES[run.kind], 'utf8'),
      jsonSchema: REPLY_SCHEMA_ARGS[run.kind], prompt,
    }
    const paths = runPaths(target.wt, run)
    await mkdir(path.dirname(paths.log), { recursive: true })
    const stream = new StructuredStream()
    let writes: Promise<void> = Promise.resolve()
    // Spec §5.2/§10: the token must never sit unredacted on disk or reach the UI live, even for the
    // seconds before the attempt ends, and never reassembled from many small pieces that no single
    // line or fragment carries in full (review finding 1, rounds 2–3). Free-text channels (narration,
    // thinking, the reconstructed answer) never reach the log or the bus raw: each is fed through its
    // own SecretHoldback and only its holdback-released, already-redacted output is persisted/
    // published. Raw json_delta fragments are never logged or published at all — their only
    // legitimate use is feeding the answer reconstruction below. The result event's raw text/
    // structured payload is captured in memory only (for #finish) and is never itself logged or
    // published — only its non-text metadata is. Detection (sawSecret) additionally decodes each raw
    // line's JSON string values before scanning, so a \u-escaped secret cannot evade it.
    let sawSecret = false
    let resultEvent: ResultEvent | null = null
    const detector = this.#detector(run.id, token)
    const narration = new SecretHoldback(token)
    const thinking = new SecretHoldback(token)
    let answer = new SecretHoldback(token)
    // Every object written or published is masked as a whole — all its string values, not just the
    // free-text ones (a tool name or session id can carry the token too, review round 4).
    const masked = <T>(value: T): T => {
      const result = maskDeep(value, token)
      if (result.secret) sawSecret = true
      return result.value
    }
    const persist = (entry: LogEntry): void => {
      const safe = masked(entry)
      writes = writes.then(() => appendFile(paths.log, `${JSON.stringify(safe)}\n`))
    }
    const publish = (event: object): void => {
      bus.publish(`irun:${run.id}`, { type: 'event', event: masked(event) })
    }
    const releaseNarration = (safe: string): void => {
      if (!safe) return
      persist({ type: 'delta', text: safe })
      publish({ type: 'delta', text: safe })
    }
    const releaseThinking = (safe: string): void => {
      if (safe) persist({ type: 'thinking', text: safe })
    }
    const releaseAnswer = (safe: string): void => {
      if (!safe) return
      persist({ type: 'answer', text: safe })
      publish({ type: 'answer_delta', text: safe })
    }
    persist({ type: 'attempt', resume })
    const outcome = await sandbox.run(
      {
        runId: run.id, runDir: paths.runDir, room: paths.room, out: paths.out, sessions: paths.sessions,
        domains: webFetch ? doc.research.domains : [], claude, extraArgs: run.kind === 'author' ? ['--add-dir', WORK_OUT] : [],
      },
      {
        timeoutMs: config.sandbox.timeoutMs,
        onLine: (line) => {
          if (findSecretsInLine(line, token).length) sawSecret = true
          const event = parseStreamLine(line)
          if (!event) {
            const text = thinkingDeltaText(line)
            if (text === null) return
            detector.feed(text)
            releaseThinking(thinking.push(text))
            return
          }
          if (event.type === 'delta') {
            detector.feed(event.text)
            releaseNarration(narration.push(event.text))
          } else if (event.type === 'result') {
            resultEvent = event
            detector.feed(event.sessionId)
            const meta = { type: 'result' as const, ok: event.ok, sessionId: event.sessionId, numTurns: event.numTurns }
            persist(meta)
            publish(meta)
          } else if (event.type === 'init' || event.type === 'message_start' || event.type === 'tool_start') {
            // Every string that reaches the log or the bus feeds the detector, in stream order
            // (round 5). Raw json_delta does not: the decoded answer_delta below is the answer's
            // text — raw JSON would feed it twice and can hide pieces behind \u escapes.
            if (event.type === 'init') detector.feed(event.sessionId)
            if (event.type === 'tool_start') detector.feed(event.name)
            persist(event)
            publish(event)
          }
          for (const derived of stream.feed(event)) {
            if (derived.type === 'answer_delta') {
              detector.feed(derived.text)
              releaseAnswer(answer.push(derived.text))
            } else if (derived.type === 'answer_reset') {
              answer.flush() // the superseded draft is dropped unreleased, but still scanned
              if (answer.sawSecret) sawSecret = true
              answer = new SecretHoldback(token)
              persist(derived)
              publish(derived)
            }
          }
        },
      },
    )
    // flush() masks a partial token a stop or timeout cut off mid-stream and reports it (finding 2).
    releaseNarration(narration.flush())
    releaseThinking(thinking.flush())
    releaseAnswer(answer.flush())
    if (narration.sawSecret || thinking.sawSecret || answer.sawSecret || detector.sawSecret) sawSecret = true
    await writes
    await this.#finish(target, run, paths, resultEvent, outcome, token, sawSecret)
  }

  async #finish(
    target: RunTarget, run: RunRecord, paths: RunPaths, resultEvent: ResultEvent | null, outcome: Awaited<ReturnType<Sandbox['run']>>,
    token: string | null, sawSecret: boolean,
  ): Promise<void> {
    // The result's text/structured payload and the container error never reach the log or the bus,
    // but they feed the finisher and the run notes: a piece of the token in any of them — even
    // halves spread over two reply fields — fails the run before anything is written (round 4).
    const inResult = maskDeep([outcome.error, resultEvent?.text, resultEvent?.structured], token).secret
    if (sawSecret || inResult) return this.#final(target, run, 'failed', ROTATE_HINT, ['a secret appeared in the agent output'])
    if (outcome.stopped) return this.#final(target, run, 'stopped', 'Stopped by the owner.')
    if (outcome.timedOut) return this.#final(target, run, 'failed', `Timed out after ${Math.round(this.deps.config.sandbox.timeoutMs / 60_000)} min.`)
    if (!resultEvent?.ok) return this.#final(target, run, 'failed', outcome.error ?? resultEvent?.text ?? 'The agent ended without a result.')
    const parsed = parseRunReply(run.kind, resultEvent.structured ?? parseJsonObject(resultEvent.text))
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
    // notes/problems can carry container stderr or a bare exception message — neither is scanned
    // by the stream-line scan above, so redact them here, the one place every outcome is recorded.
    const token = await this.deps.sandbox.token()
    const safeNotes = notes === null ? null : redactSecrets(notes, token)
    const safeProblems = problems ? problems.map((p) => redactSecrets(p, token)) : undefined
    await updateInitiative(target.ini.dir, (d) => {
      const base = mutate ? mutate(d) : d
      const current = base.runs.find((r) => r.id === run.id) ?? run
      return upsertRun(base, { ...current, outcome, notes: safeNotes, ended_at: nowIso(this.#now()), ...(safeProblems ? { problems: safeProblems } : {}) })
    })
  }

  // A run waiting for the owner keeps its room, output and session store for Resume; a relaunched
  // run (outcome running again) is not settled yet.
  async #settle(target: RunTarget, run: RunRecord): Promise<void> {
    const current = findRun(await readInitiative(target.ini.dir), run.id)
    if (current.outcome === 'running') return
    // A run waiting for the owner also keeps its secret detector: the resumed attempt continues it.
    if (current.outcome !== 'needs_owner') {
      this.#detectors.delete(run.id)
      await this.deps.sandbox.cleanup(run.id, runPaths(target.wt, run).runDir).catch((error: unknown) => console.error(error))
    }
    this.deps.bus.publish(`irun:${run.id}`, { type: 'done', outcome: current.outcome })
    this.#changed(target)
  }

  async #final(target: RunTarget, run: RunRecord, outcome: RunRecord['outcome'], notes: string | null, problems?: string[]): Promise<void> {
    await this.#record(target, run, outcome, notes, problems)
    await this.#settle(target, run)
  }
}
