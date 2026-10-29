import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectAgent } from './agent-routing.ts'
import { appendAudit, auditId, estimateApiUsd } from './agent-usage.ts'
import type { Config } from './config.ts'
import { pendingBlocking, runDecisions } from './decision-model.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { type ExecutionAttempt, type ExecutionEvent } from './execution-model.ts'
import { attemptDirectory, captureExecutionBoundary, observeAttempt, startLocalAttempt, requireAttemptInactive, stopLocalAttempt, writeExecutionArtifact } from './execution-receipts.ts'
import { ensureExcluded, git } from './git.ts'
import { type InitiativeAttemptInput, InitiativeAttemptInputSchema, InitiativeAttemptResultSchema, type InitiativeAttemptResult } from './initiative-attempt.ts'
import { readInitiativeBlob, readInitiativeStream, recordInitiativeEvents, type InitiativeEventPayload } from './initiative-events.ts'
import { parseRunReply, REPLY_SCHEMA_ARGS, type RunReplies, validateRunReply } from './initiative-protocol.ts'
import { findRun, type InitiativeDoc, readInitiative, withInitiativeLock, type RunKind, type RunRecord, runLogPath } from './initiative-store.ts'
import { type InitiativeRef, sliceStatuses } from './initiatives.ts'
import { parseJsonObject, retryPrompt } from './protocol.ts'
import { newId, nowIso, readReview } from './review-store.ts'
import { assembleRoom, type RoomInput } from './room.ts'
import { logText } from './run-stream.ts'
import { FIXES, type Sandbox } from './sandbox.ts'
import { agentTools, containerName, WORK_IN, WORK_OUT } from './sandbox-args.ts'
import { maskDeep, redactSecrets, ROTATE_HINT } from './secret-scan.ts'
import { reconcileGitEffect, withGitEffectLock } from './git-effect.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { proposeBlocker } from './slice-plan.ts'
import { withDetachedReviewLocks } from './review-lock.ts'

export interface RunTarget { wt: WorktreeInfo; ini: InitiativeRef }
export interface RunPaths { runDir: string; room: string; out: string; sessions: string; log: string }
export interface RunContext {
  target: RunTarget; run: RunRecord; paths: RunPaths; config: Config; token: string | null; at: string
  attempt: ExecutionAttempt; input: InitiativeAttemptInput; result: InitiativeAttemptResult; recovering: boolean; ownerRetry: boolean
  record(outcome: RunRecord['outcome'], notes: string | null, problems?: string[]): Promise<void>
  relaunch(patch: Partial<RunRecord>, prompt: string): Promise<void>
}
export type Finisher<K extends RunKind> = (ctx: RunContext, reply: RunReplies[K]) => Promise<void>
export type Finishers = { [K in RunKind]?: Finisher<K> }
export interface ResumeGuard { key: string; busy: HttpError; check: (doc: InitiativeDoc) => void }
export interface RunDeps { config: Config; bus: EventBus; sandbox: Sandbox; finishers: Finishers; now?: () => Date }
const RULES: Record<RunKind, URL> = { planner: new URL('./prompts/planner.md', import.meta.url), author: new URL('./prompts/author.md', import.meta.url), research: new URL('./prompts/research.md', import.meta.url) }
const worker = fileURLToPath(new URL('./initiative-sandbox-worker.ts', import.meta.url))
const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const busy = (run: RunRecord) => ['queued', 'running', 'uncertain'].includes(run.outcome)
export const readsWeb = (run: Pick<RunRecord, 'kind' | 'phase' | 'web_fetch'>): boolean => run.kind === 'research' && run.phase === 'read' && run.web_fetch === true
export function runPaths(wt: WorktreeInfo, run: Pick<RunRecord, 'id' | 'log'>): RunPaths {
  const runDir = path.join(wt.path, '.spec-review', 'runs', run.id)
  return { runDir, room: path.join(runDir, 'room'), out: path.join(runDir, 'out'), sessions: path.join(runDir, 'sessions'), log: path.join(wt.path, run.log) }
}
const attemptPaths = (wt: WorktreeInfo, id: string): RunPaths => {
  const runDir = path.join(wt.path, '.spec-review/initiative-attempts', id)
  return { runDir, room: path.join(runDir, 'room'), out: path.join(runDir, 'out'), sessions: path.join(runDir, 'sessions'), log: path.join(runDir, 'log.ndjson') }
}
async function filesHash(dir: string, prefix = ''): Promise<string[]> {
  const values: string[] = []
  for (const name of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${name.name}` : name.name
    if (name.isDirectory()) values.push(...await filesHash(path.join(dir, name.name), relative))
    else if (name.isFile()) values.push(`${relative}:${createHash('sha256').update(await readFile(path.join(dir, name.name))).digest('hex')}`)
    else throw new Error('Execution room contains a non-regular file')
  }
  return values
}
export class InitiativeRunService {
  #follows = new Map<string, Promise<void>>()
  #starting = new Set<string>()
  #logOffsets = new Map<string,number>()
  constructor(private readonly deps: RunDeps) {}
  #now() { return nowIso((this.deps.now ?? (() => new Date()))()) }
  async settled(runId: string): Promise<void> {
    for (;;) { const current = this.#follows.get(runId); if (!current) return; await current; if (this.#follows.get(runId) === current) return }
  }
  async exclusive<T>(key: string, error: HttpError, fn: () => Promise<T>): Promise<T> {
    if (this.#starting.has(key)) throw error
    this.#starting.add(key); try { return await fn() } finally { this.#starting.delete(key) }
  }
  async requireReady(): Promise<void> {
    const status = await this.deps.sandbox.status()
    if (!status.ready) throw new HttpError(409, 'sandbox_unavailable', `The sandbox is not ready: ${status.fixes.join(', ')}`)
  }
  async requireBrowser(): Promise<void> {
    if (!(await this.deps.sandbox.status()).browserImage) throw new HttpError(409, 'browser_unavailable', `The research browser is not ready: ${FIXES.browser}`)
  }
  async #events(target: RunTarget, events: InitiativeEventPayload[]): Promise<void> {
    const history = await readInitiativeStream(target.ini.dir)
    await recordInitiativeEvents(target.ini.dir, history, events, this.#now())
  }
  #execution(event: ExecutionEvent): InitiativeEventPayload { return { type: 'InitiativeExecutionRecorded', execution: event } }
  #changed(target: RunTarget) { this.deps.bus.publish('initiative', { worktreeId: target.wt.id, name: target.ini.name }) }
  async begin(target: RunTarget, fields: Pick<RunRecord, 'kind'> & Partial<RunRecord>, prompt: string, room?: RoomInput['target']): Promise<RunRecord> {
    return withWorktreeAdmission(target.wt.path,async()=>{
      await assertWorktreeAdmission(target.wt.path,{operation:'initiative'})
      return withInitiativeLock(target.ini.dir, async () => {
      const doc = await readInitiative(target.ini.dir)
      if(fields.kind==='planner'&&doc.plan.status==='approved')throw new HttpError(409,'plan_approved','The plan has already been approved')
      if(fields.kind==='author'&&doc.plan.status!=='approved')throw new HttpError(409,'plan_not_approved','Approve the plan before proposing a slice')
      if(fields.kind==='author') {
        const blocker=proposeBlocker(doc.plan.slices,await sliceStatuses(target.wt,doc),fields.slice??'')
        if(blocker)throw new HttpError(409,'slice_not_ready',blocker)
      }
      if (fields.kind !== 'research' && doc.runs.some(run => run.kind === fields.kind && (busy(run) || run.outcome === 'needs_owner'))) throw new HttpError(409, `${fields.kind}_running`, `Another ${fields.kind} execution still owns this initiative`)
      const id = newId('r'), at = this.#now(), execution_id = randomUUID()
      const run: RunRecord = { slice: null, topic: null, notes: null, ...fields, id, execution_id, session: randomUUID(), container: containerName(id), log: runLogPath(id), started_at: at, ended_at: null, outcome: 'queued' }
      const prepared = await this.#prepare(target, run, prompt, false, 'initial', room)
      await this.#events(target, [{ type: 'InitiativeRunRequested', run }, this.#execution({ type: 'ExecutionQueued', request: { id: execution_id, role: run.kind, threadId: null, messageCount: 0, at } }), ...prepared.events])
      await this.#dispatch(target,run,prepared.attempt)
      this.#launch(target, run.id, prepared.attempt, false)
      this.#changed(target)
      return findRun(await readInitiative(target.ini.dir), id)
    })})
  }
  async #prepare(target: RunTarget, run: RunRecord, prompt: string, resume: boolean, cause: ExecutionAttempt['cause'], room?: RoomInput['target']): Promise<{ attempt: ExecutionAttempt; events: InitiativeEventPayload[] }> {
    const id = randomUUID(), paths = attemptPaths(target.wt, id)
    for (const dir of [paths.room, paths.out, paths.sessions]) await mkdir(dir, { recursive: true })
    await chmod(paths.out, 0o777); await chmod(paths.sessions, 0o777)
    await ensureExcluded(target.wt.path)
    const doc = await readInitiative(target.ini.dir), stream = await readInitiativeStream(target.ini.dir)
    const statuses = await sliceStatuses(target.wt, doc)
    const targetSlice = room ?? (run.slice && run.change ? { sliceId: run.slice, notes: '', change: run.change } : undefined)
    await assembleRoom(paths.room, { worktree: target.wt.path, initiativeDir: target.ini.dir, doc, kind: run.kind, statuses, target: targetSlice })
    const brief = stream.events.reduce<string>((previous, { event }) => event.type === 'InitiativeCreated' ? event.brief : event.type === 'InitiativeBriefSaved' ? event.blob : previous, '')
    await writeFile(path.join(paths.room, 'initiative/brief.md'), await readInitiativeBlob(target.ini.dir, brief))
    for (const input of doc.inputs.filter(input => !input.draft)) await writeFile(path.join(paths.room, 'initiative/inputs', input.file), await readInitiativeBlob(target.ini.dir, input.blob))
    const routing = await selectAgent(this.deps.config, run.kind, [run.topic, run.questions].filter(Boolean).join('\n') || prompt)
    const web = readsWeb(run), tools = agentTools(run.kind, web)
    const read_domains = [...new Set([...(run.read_domains ?? []), ...(web ? doc.research.domains : [])])]
    const sessions = runPaths(target.wt, run).sessions
    await mkdir(sessions, { recursive: true }); await chmod(sessions, 0o777)
    const input = InitiativeAttemptInputSchema.parse({ version: 1, attemptId: id, runId: run.id, kind: run.kind, provider: this.deps.sandbox.durableProvider(),
      sandboxId: `a_${id}`, ...paths, sessions, timeoutMs: this.deps.config.sandbox.timeoutMs, domains: web ? doc.research.domains : [], browser: web,
      codex: { kind: 'agent', bin: 'codex', cwd: WORK_IN, sessionId: run.session, resume, model: routing.model, reasoningEffort: routing.reasoningEffort, allowedTools: tools.allowed, disallowedTools: tools.disallowed, permissionMode: tools.permissionMode, appendSystemPrompt: await readFile(RULES[run.kind], 'utf8'), jsonSchema: REPLY_SCHEMA_ARGS[run.kind], prompt, toolsScript: '/opt/spec-review/desk-tools.mjs', writeRoot: run.kind === 'author' ? WORK_OUT : undefined, search: run.kind === 'research' && !web, readDomains: web ? doc.research.domains : [] },
      source: { journal: stream.version, brief, inputs: doc.inputs.map(({file,blob,draft}) => ({file,blob,draft})), planHash: hash(doc.plan), roomHash: hash(await filesHash(paths.room)) } })
    const token = await this.deps.sandbox.token()
    if ((token && JSON.stringify(input).includes(token)) || maskDeep({ prompt, system: input.codex.appendSystemPrompt }, token).secret) throw new HttpError(422, 'unsafe_execution_input', 'Execution input contains credential material')
    const inputFile = path.join(paths.runDir, 'input.json'), resultFile = path.join(attemptDirectory(target.wt.path,id), 'result.ndjson')
    await writeExecutionArtifact(inputFile, input)
    const attempt: ExecutionAttempt = { id, at: this.#now(), cause, processBoundary: await captureExecutionBoundary(), head: (await git(target.wt.path, ['rev-parse', 'HEAD'])).trim(), sourceHash: hash(input), routing, decisions: runDecisions(await readReview(target.ini.dir), run.id),
      spec: { kind: 'command', bin: process.execPath, cwd: target.wt.path, args: ['--import', import.meta.resolve('tsx'), worker, inputFile, resultFile, hash(input)], environment: {}, resultFile } }
    return { attempt, events: [{ type: 'InitiativeRunParametersSelected', runId: run.id, session: run.session, container:containerName(input.sandboxId), phase: run.phase, web_fetch: run.web_fetch, read_domains, validation_retry: run.validation_retry ?? false }, this.#execution({ type: 'ExecutionAttemptRequested', runId: run.execution_id, attempt })] }
  }
  resumeRun(target: RunTarget, runId: string, patch: Partial<RunRecord>, prompt: (decisions: ReturnType<typeof runDecisions>) => string, guard?: ResumeGuard): Promise<void> {
    const again = new HttpError(409, 'run_not_waiting', 'The run is already being resumed')
    return this.exclusive(`${target.ini.dir}#run:${runId}`, again, () => guard ? this.exclusive(guard.key, guard.busy, () => this.#resume(target, runId, patch, prompt, guard.check)) : this.#resume(target, runId, patch, prompt))
  }
  async #resume(target: RunTarget, runId: string, patch: Partial<RunRecord>, prompt: (decisions: ReturnType<typeof runDecisions>) => string, check?: (doc: InitiativeDoc) => void): Promise<void> {
    await this.reconcile(target)
    return withWorktreeAdmission(target.wt.path, async () => {
      const snapshot=await readInitiative(target.ini.dir),existing=findRun(snapshot,runId)
      const ownEffect=(await readInitiativeStream(target.ini.dir)).events.findLast(({event})=>event.type==='InitiativeRunGitRequested'&&event.runId===runId)?.event
      await assertWorktreeAdmission(target.wt.path,{operation:'initiative',runId:existing.execution_id,effectId:ownEffect?.type==='InitiativeRunGitRequested'?ownEffect.plan.effectId:undefined})
      return withInitiativeLock(target.ini.dir, async () => {
      const doc = await readInitiative(target.ini.dir), run = findRun(doc, runId)
      if (!['needs_owner', 'uncertain'].includes(run.outcome)) throw new HttpError(409, 'run_not_waiting', `Run ${runId} is ${run.outcome}`)
      const execution = doc.executions.find(item => item.request.id === run.execution_id)!, previous = execution.attempts.at(-1)!
      const input = await this.#input(target, previous)
      await this.#inactive(target, previous, input)
      const decisions = runDecisions(await readReview(target.ini.dir), runId)
      if (pendingBlocking(decisions).length) throw new HttpError(409, 'decisions_pending', 'Blocking owner decisions remain open')
      const plan = (await readInitiativeStream(target.ini.dir)).events.findLast(({event}) => event.type === 'InitiativeRunGitRequested' && event.runId === runId && event.attemptId === previous.id)
      if (plan && previous.receiptHash) { await this.#consume(target, runId, previous, true, true); return }
      if (run.kind==='planner' && doc.plan.status==='approved') throw new HttpError(409,'plan_approved','The plan has already been approved')
      const checked = { ...doc, runs: doc.runs.filter(item => item.id !== runId) }; check?.(checked)
      await this.requireReady(); if (readsWeb({...run,...patch})) await this.requireBrowser()
      const prepared = await this.#prepare(target, { ...run, ...patch, validation_retry: false }, prompt(decisions), true, 'owner-resume')
      await this.#events(target, prepared.events)
      await this.#dispatch(target,run,prepared.attempt)
      this.#launch(target, runId, prepared.attempt, false)
      this.#changed(target)
    })})
  }
  async #input(target: RunTarget, attempt: ExecutionAttempt): Promise<InitiativeAttemptInput> {
    const input = InitiativeAttemptInputSchema.parse(JSON.parse(await readFile(path.join(attemptPaths(target.wt, attempt.id).runDir, 'input.json'), 'utf8')))
    if (input.attemptId !== attempt.id || hash(input) !== attempt.sourceHash) throw new Error('Initiative attempt input changed')
    return input
  }
  async #inactive(target: RunTarget, attempt: ExecutionAttempt, input: InitiativeAttemptInput): Promise<void> {
    await requireAttemptInactive(target.wt.path, attempt.id, attempt.processBoundary)
    const state = await this.deps.sandbox.inspect(input.sandboxId)
    if (state === 'running' || state === 'unknown') throw new HttpError(409, 'execution_active', 'The previous sandbox may still be running')
  }
  #launch(target: RunTarget, runId: string, attempt: ExecutionAttempt, recovering: boolean) {
    let follow:Promise<void>
    follow = withDetachedReviewLocks(()=>this.#follow(target, runId, attempt, recovering).catch(async error => {
      await this.#uncertain(target, runId, attempt.id, error instanceof Error ? error.message : String(error))
    }).finally(()=>{if(this.#follows.get(runId)===follow)this.#follows.delete(runId)}))
    this.#follows.set(runId, follow)
  }
  async #dispatch(target:RunTarget,run:RunRecord,attempt:ExecutionAttempt):Promise<void> {
    await assertWorktreeAdmission(target.wt.path,{operation:'initiative',runId:run.execution_id})
    try {await startLocalAttempt(attempt,this.deps.config.sandbox.timeoutMs+30_000)}
    catch(error){await this.#uncertain(target,run.id,attempt.id,error instanceof Error?error.message:String(error))}
  }
  async #uncertain(target: RunTarget, runId: string, attemptId: string | null, reason: string) {
    await withInitiativeLock(target.ini.dir, async () => {
      const run = findRun(await readInitiative(target.ini.dir), runId)
      if (run.outcome === 'uncertain' && run.notes === reason) return
      await this.#events(target, [this.#execution({ type: 'ExecutionUncertain', runId: run.execution_id, attemptId, reason: redactSecrets(reason, await this.deps.sandbox.token()) })])
      this.#changed(target)
    })
  }
  async #follow(target: RunTarget, runId: string, attempt: ExecutionAttempt, recovering: boolean): Promise<void> {
    for (;;) {
      await this.#publishLog(target,runId,attempt.id)
      const observation = await observeAttempt(target.wt.path, attempt.id)
      if (observation.kind === 'receipt') { await withGitEffectLock(target.wt.path, () => withInitiativeLock(target.ini.dir, () => this.#consume(target, runId, attempt, recovering, false))); return }
      if (observation.kind === 'uncertain') { await this.#uncertain(target, runId, attempt.id, observation.reason); return }
      await withInitiativeLock(target.ini.dir, async () => {
        const doc = await readInitiative(target.ini.dir), run = findRun(doc, runId), current = doc.executions.find(item => item.request.id === run.execution_id)?.attempts.at(-1)
        if (current?.id === attempt.id && !current.identity) await this.#events(target, [this.#execution({type:'ExecutionAttemptObserved',runId:run.execution_id,attemptId:attempt.id,identity:observation.identity})])
      })
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  async #publishLog(target:RunTarget,runId:string,attemptId:string):Promise<void> {
    const text=await readFile(attemptPaths(target.wt,attemptId).log,'utf8').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error})
    if(Buffer.byteLength(text)>8_000_000)throw new Error('Initiative log exceeds its size limit')
    const lines=text.split('\n');lines.pop()
    const offset=this.#logOffsets.get(attemptId)??0
    const token=await this.deps.sandbox.token()
    for(const line of lines.slice(offset)) {
      const entry=JSON.parse(line)
      if(entry.type==='delta'||entry.type==='answer')this.deps.bus.publish(`irun:${runId}`,{type:'event',event:maskDeep({type:entry.type==='answer'?'answer_delta':'delta',text:entry.text},token).value})
    }
    this.#logOffsets.set(attemptId,lines.length)
  }
  async #consume(target: RunTarget, runId: string, attempt: ExecutionAttempt, recovering: boolean, ownerRetry: boolean): Promise<void> {
    const doc = await readInitiative(target.ini.dir), run = findRun(doc, runId), execution = doc.executions.find(item => item.request.id === run.execution_id)!, current = execution.attempts.at(-1)!
    if (current.id !== attempt.id || (['done','failed','stopped'].includes(run.outcome) && !ownerRetry)) return
    const ownEffect=(await readInitiativeStream(target.ini.dir)).events.findLast(({event})=>event.type==='InitiativeRunGitRequested'&&event.runId===runId&&event.attemptId===attempt.id)?.event
    await assertWorktreeAdmission(target.wt.path,{operation:'initiative',runId:run.execution_id,effectId:ownEffect?.type==='InitiativeRunGitRequested'?ownEffect.plan.effectId:undefined})
    const observed = await observeAttempt(target.wt.path, attempt.id)
    if(observed.kind==='receipt'&&observed.receipt.kind==='command'&&current.stopRequested) {
      const input=await this.#input(target,attempt)
      for(let i=0;;i++) {
        try {await this.#inactive(target,attempt,input);break}
        catch(error) {
          if(i>=19)return this.#uncertain(target,runId,attempt.id,`Stop requested but execution inactivity is unproven: ${error instanceof Error?error.message:String(error)}`)
          await new Promise(resolve=>setTimeout(resolve,50))
        }
      }
      if(current.receiptHash&&current.receiptHash!==observed.hash)return this.#uncertain(target,runId,attempt.id,'The stopped execution receipt changed')
      if(!current.receiptHash)await this.#events(target,[
        ...(!current.identity?[this.#execution({type:'ExecutionAttemptObserved',runId:run.execution_id,attemptId:attempt.id,identity:observed.receipt.identity})]:[]),
        this.#execution({type:'ExecutionReceiptAccepted',runId:run.execution_id,attemptId:attempt.id,receiptHash:observed.hash,session:null}),
      ])
      return this.#record(target,runId,attempt,'stopped','Stopped by the owner.',[])
    }
    if (observed.kind !== 'receipt' || observed.receipt.kind !== 'command' || !observed.receipt.result.artifact) return this.#uncertain(target, runId, attempt.id, 'The initiative result receipt is missing')
    const input = await this.#input(target, attempt)
    if (hash(await filesHash(input.room)) !== input.source.roomHash) return this.#uncertain(target, runId, attempt.id, 'The immutable execution room changed')
    const result = InitiativeAttemptResultSchema.parse(JSON.parse(Buffer.from(observed.receipt.result.artifact.content, 'base64').toString('utf8')))
    if (result.attemptId !== attempt.id) return this.#uncertain(target, runId, attempt.id, 'Sandbox result identity mismatch')
    if (current.receiptHash && current.receiptHash !== observed.hash) return this.#uncertain(target, runId, attempt.id, 'Sandbox receipt changed')
    for(let i=0;;i++) {
      try {await this.#inactive(target,attempt,input);break}
      catch(error) {
        if(i>=19)return this.#uncertain(target,runId,attempt.id,`Execution result is recorded but inactivity is unproven: ${error instanceof Error?error.message:String(error)}`)
        await new Promise(resolve=>setTimeout(resolve,50))
      }
    }
    if (!current.receiptHash) await this.#events(target, [
      ...(!current.identity ? [this.#execution({type:'ExecutionAttemptObserved',runId:run.execution_id,attemptId:attempt.id,identity:observed.receipt.identity})] : []),
      this.#execution({type:'ExecutionReceiptAccepted',runId:run.execution_id,attemptId:attempt.id,receiptHash:observed.hash,session:result.result?.sessionId ?? null})])
    const token = await this.deps.sandbox.token()
    const paths = { ...attemptPaths(target.wt, attempt.id), sessions: input.sessions }
    const record = (outcome: RunRecord['outcome'], notes: string | null, problems: string[] = []) => this.#record(target, runId, attempt, outcome, notes, problems)
    const context: RunContext = { target, run: findRun(await readInitiative(target.ini.dir), runId), paths, config:this.deps.config, token, at:attempt.at, attempt,input,result,recovering,ownerRetry,record,
      relaunch: async (patch,prompt) => {
        if (recovering) { await record('needs_owner','The recorded result requests another attempt. Resume explicitly.'); return }
        const next = { ...findRun(await readInitiative(target.ini.dir),runId), ...patch }
        if (readsWeb(next) && !(await this.deps.sandbox.status()).browserImage) {
          await this.#events(target,[{type:'InitiativeRunParametersSelected',runId,session:next.session,container:next.container,phase:next.phase,web_fetch:next.web_fetch,read_domains:next.read_domains??[],validation_retry:next.validation_retry??false}])
          await record('needs_owner', `The research browser image is missing. ${FIXES.browser}`); return
        }
        const prepared = await this.#prepare(target,next,prompt,true,patch.validation_retry?'validation-retry':'owner-resume')
        await this.#events(target,prepared.events); await this.#dispatch(target,next,prepared.attempt);this.#launch(target,runId,prepared.attempt,false)
      } }
    if (maskDeep(result,token).secret || result.sawSecret) return record('failed',ROTATE_HINT,['A secret appeared in the agent output'])
    if (result.outcome.stopped || current.stopRequested || observed.receipt.stopped) return record('stopped','Stopped by the owner.')
    if (result.outcome.timedOut || observed.receipt.result.timedOut) return record('failed','The execution timed out.')
    if (!result.result?.ok || result.outcome.error) return record('failed',result.outcome.error ?? result.result?.text ?? 'The agent ended without a result.')
    const parsed = parseRunReply(run.kind,result.result.structured ?? parseJsonObject(result.result.text))
    const issues = parsed.reply ? validateRunReply(run.kind,parsed.reply,{change:run.change}) : parsed.issues
    if (issues.length) {
      if (!run.validation_retry) return context.relaunch({validation_retry:true},retryPrompt(issues))
      return record('failed','The reply did not pass validation twice.',issues)
    }
    const finisher = this.deps.finishers[run.kind] as Finisher<typeof run.kind> | undefined
    if (!finisher) return record('failed',`No handler for ${run.kind} runs`)
    await finisher(context,parsed.reply!)
    this.#changed(target)
  }
  async #record(target:RunTarget,runId:string,attempt:ExecutionAttempt,outcome:RunRecord['outcome'],notes:string|null,problems:string[]) {
    const doc=await readInitiative(target.ini.dir),run=findRun(doc,runId),execution=doc.executions.find(item=>item.request.id===run.execution_id)!
    if (outcome==='queued'||outcome==='running') throw new Error('A result cannot restart execution')
    const token=await this.deps.sandbox.token(),events:InitiativeEventPayload[]=[]
    if (outcome==='uncertain') events.push(this.#execution({type:'ExecutionUncertain',runId:run.execution_id,attemptId:attempt.id,reason:notes??'Finalization outcome is uncertain'}))
    else if (execution.outcome==='running'||execution.outcome==='uncertain') events.push(this.#execution({type:'ExecutionSettled',runId:run.execution_id,attemptId:attempt.id,outcome,at:this.#now()}))
    events.push({type:'InitiativeRunOutcomeRecorded',runId,attemptId:attempt.id,outcome,notes:notes===null?null:redactSecrets(notes,token),problems:problems.map(problem=>redactSecrets(problem,token)),at:this.#now()})
    await this.#events(target,events)
    if (!['needs_owner','uncertain'].includes(outcome)) {
      const input=await this.#input(target,attempt)
      await this.deps.sandbox.cleanup(input.sandboxId,path.join(input.runDir,'sandbox')).catch(()=>undefined)
    }
    if (attempt.routing) await appendAudit(this.deps.config,{id:auditId(runId,attempt.id),type:'completed',at:this.#now(),role:run.kind,runId,worktreeId:target.wt.id,target:target.ini.name,resume:attempt.cause!=='initial',routing:attempt.routing,ok:outcome==='done',actualBilledUsd:null})
    this.deps.bus.publish(`irun:${runId}`,{type:'done',outcome});this.#changed(target)
  }
  async stop(target:RunTarget,runId:string):Promise<void> {
    return withGitEffectLock(target.wt.path,()=>withInitiativeLock(target.ini.dir,async()=>{
      const doc=await readInitiative(target.ini.dir),run=findRun(doc,runId),attempt=doc.executions.find(item=>item.request.id===run.execution_id)?.attempts.at(-1)
      if (!attempt||!['running','queued','uncertain','needs_owner'].includes(run.outcome)) throw new HttpError(409,'run_not_running','The run has already settled')
      const history=await readInitiativeStream(target.ini.dir)
      const pending=history.events.findLast(({event})=>event.type==='InitiativeRunGitRequested'&&event.runId===runId)?.event
      if(pending?.type==='InitiativeRunGitRequested'&&!history.events.some(({event})=>event.type==='InitiativeRunGitCompleted'&&event.effectId===pending.plan.effectId)) {
        const effect=await reconcileGitEffect(target.wt.path,pending.plan)
        if(effect.status==='completed'){await this.#consume(target,runId,attempt,true,false);return}
        throw new HttpError(409,'git_effect_pending','The recorded Git effect must be reconciled or explicitly resumed before stopping this run')
      }
      const input=await this.#input(target,attempt)
      if (!attempt.stopRequested) await this.#events(target,[this.#execution({type:'ExecutionStopRequested',runId:run.execution_id,attemptId:attempt.id})])
      await writeFile(path.join(input.runDir,'stop.request'),'owner stop\n',{flag:'wx',mode:0o600}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error})
      await this.deps.sandbox.stop(input.sandboxId);await stopLocalAttempt(target.wt.path,attempt.id,attempt.processBoundary)
      if(run.outcome==='needs_owner') {
        await this.#inactive(target,attempt,input)
        await this.#events(target,[{type:'InitiativeRunAbandoned',runId,at:this.#now()}]);this.#changed(target);return
      }
      const observation=await observeAttempt(target.wt.path,attempt.id)
      if(observation.kind==='receipt'){await this.#consume(target,runId,attempt,true,false);return}
      if(observation.kind==='live'&&!this.#follows.has(runId))this.#launch(target,runId,attempt,true)
      if (run.outcome==='uncertain') {
        await this.#inactive(target,attempt,input)
        await this.#events(target,[{type:'InitiativeRunAbandoned',runId,at:this.#now()}]);this.#changed(target)
      }
    }))
  }
  async reconcile(target:RunTarget):Promise<void> {
    const doc=await readInitiative(target.ini.dir)
    for (const run of doc.runs.filter(run=>busy(run))) {
      if (this.#follows.has(run.id)) continue
      const attempt=doc.executions.find(item=>item.request.id===run.execution_id)?.attempts.at(-1)
      if (!attempt) {await this.#uncertain(target,run.id,null,'Execution was queued without an attempt');continue}
      const observation=await observeAttempt(target.wt.path,attempt.id)
      if (observation.kind==='receipt') await withGitEffectLock(target.wt.path,()=>withInitiativeLock(target.ini.dir,()=>this.#consume(target,run.id,attempt,true,false)))
      else if (observation.kind==='live') this.#launch(target,run.id,attempt,true)
      else await this.#uncertain(target,run.id,attempt.id,observation.reason)
    }
  }
  failStale(target:RunTarget):Promise<void> {return this.reconcile(target)}
  async log(target:RunTarget,runId:string):Promise<{run:RunRecord;text:string}> {
    const doc=await readInitiative(target.ini.dir),run=findRun(doc,runId),execution=doc.executions.find(item=>item.request.id===run.execution_id)
    const texts=await Promise.all((execution?.attempts??[]).map(attempt=>readFile(attemptPaths(target.wt,attempt.id).log,'utf8').catch(()=>'')))
    return {run,text:redactSecrets(logText(texts.join('\n')),await this.deps.sandbox.token())}
  }
}
