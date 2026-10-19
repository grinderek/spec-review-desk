import { decodeJournalRecord, prepareJournalRecord } from './journal-schema.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { HttpError } from './errors.ts'
import { withReviewLock } from './review-lock.ts'
import { INITIATIVE_NAME, INPUT_FILE, CHANGE_NAME, InputSchema, SliceSchema, InitiativeSchema, RunSchema, type InitiativeDoc } from './initiative-model.ts'
import { ExecutionEventSchema, projectExecution } from './execution-model.ts'
import { GitEffectPlanSchema } from './git-effect.ts'
import { InitiativeFileError, writeInitiativeProjection } from './initiative-store.ts'
import { InitiativeOwnerGitSchemas, projectInitiativeOwnerGit } from './initiative-owner-effect-model.ts'

export const INITIATIVE_EVENTS_FILE = 'initiative.events.jsonl'
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const Blob = z.string().regex(/^[0-9a-f]{64}$/)
const Payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('InitiativeCreated'), creationId:z.uuid(), name: z.string().regex(INITIATIVE_NAME), title: z.string().min(1), repo: z.string().min(1), created_at: z.string(), brief: Blob }),
  z.object({ type: z.literal('InitiativeBriefSaved'), blob: Blob }),
  z.object({ type: z.literal('InitiativeInputAdded'), input: InputSchema }),
  z.object({ type: z.literal('ResearchInputAccepted'), file: z.string().regex(INPUT_FILE) }),
  z.object({ type: z.literal('ResearchInputDiscarded'), file: z.string().regex(INPUT_FILE) }),
  z.object({ type: z.literal('ResearchDomainsSet'), domains: z.array(z.string()) }),
  z.object({ type: z.literal('ResearchDomainsGranted'), domains: z.array(z.string()), decision: z.string(), commit: z.string() }),
  z.object({ type: z.literal('SlicePlanDrafted'), slices: z.array(SliceSchema), run: z.string(), attempt: z.uuid().optional() }),
  z.object({ type: z.literal('SlicePlanEdited'), slices: z.array(SliceSchema) }),
  z.object({ type: z.literal('SlicePlanApproved'), slices: z.array(SliceSchema), approved_at: z.string() }),
  z.object({ type: z.literal('SliceChangeAssociated'), slice: z.string(), change: z.string().regex(CHANGE_NAME).nullable() }),
  z.object({ type: z.literal('InitiativeRunRequested'), run: RunSchema }),
  z.object({ type: z.literal('InitiativeExecutionRecorded'), execution: ExecutionEventSchema }),
  z.object({ type: z.literal('InitiativeRunParametersSelected'), runId: z.string(), session: z.string(), container: z.string(), phase: z.enum(['search', 'read']).optional(), web_fetch: z.boolean().optional(), read_domains: z.array(z.string()), validation_retry: z.boolean() }),
  z.object({ type: z.literal('InitiativeRunOutcomeRecorded'), runId: z.string(), attemptId: z.uuid(), outcome: z.enum(['done', 'needs_owner', 'failed', 'stopped', 'uncertain']), notes: z.string().nullable(), problems: z.array(z.string()), at: z.string() }),
  z.object({ type: z.literal('InitiativeRunAbandoned'), runId: z.string(), at: z.string() }),
  z.object({ type: z.literal('InitiativeRunGitRequested'), runId: z.string(), attemptId: z.uuid(), plan: GitEffectPlanSchema }),
  z.object({ type: z.literal('InitiativeRunGitCompleted'), runId: z.string(), effectId: z.uuid(), commit: z.string() }),
  ...InitiativeOwnerGitSchemas,
])
const Event = z.object({ version: z.literal(1), stream: z.string().uuid(), sequence: z.number().int().positive(), id: z.string().uuid(), command: z.string().uuid(), at: z.string(), origin: z.enum(['initiative-command', 'fixture']), event: Payload })
export type InitiativeEventPayload = z.infer<typeof Payload>
export type InitiativeEvent = z.infer<typeof Event>
export interface InitiativeStream { events: InitiativeEvent[]; bytes: string; version: string }

// Creation prepares these exact bytes before any worktree or repository effect starts.
export function buildInitialInitiativeStream(input:{creationId:string;streamId:string;commandId:string;at:string;name:string;title:string;repo:string;brief:string;inputs:InitiativeDoc['inputs']}):{bytes:string;projection:InitiativeDoc} {
  z.uuid().parse(input.creationId);z.uuid().parse(input.streamId);z.uuid().parse(input.commandId)
  const payloads:InitiativeEventPayload[]=[{type:'InitiativeCreated',creationId:input.creationId,name:input.name,title:input.title,repo:input.repo,created_at:input.at,brief:input.brief},...input.inputs.map(entry=>({type:'InitiativeInputAdded' as const,input:entry}))]
  const events=payloads.map((event,index)=>{
    const digest=hash(`${input.creationId}:${input.streamId}:${input.commandId}:${index+1}`)
    const id=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`
    return prepareJournalRecord(Event, {version:1,stream:input.streamId,sequence:index+1,id,command:input.commandId,at:input.at,origin:'initiative-command',event})
  })
  return {bytes:events.map(event=>`${JSON.stringify(event)}\n`).join(''),projection:projectInitiative(events)}
}

export async function readInitiativeStream(dir: string): Promise<InitiativeStream> {
  const file = path.join(dir, INITIATIVE_EVENTS_FILE)
  const bytes = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  const events: InitiativeEvent[] = []
  try {
    const ids = new Set<string>()
    for (const line of bytes.split('\n').filter(Boolean)) {
      const event = decodeJournalRecord(Event, JSON.parse(line))
      if (event.sequence !== events.length + 1 || (events.length && event.stream !== events[0]!.stream)) throw new Error('invalid stream identity or sequence')
      if (ids.has(event.id)) throw new Error('duplicate event id')
      ids.add(event.id)
      events.push(event)
    }
    if (events.length && events[0]!.event.type !== 'InitiativeCreated') throw new Error('first event must create initiative')
    if (events.slice(1).some(e => e.event.type === 'InitiativeCreated')) throw new Error('initiative cannot be created twice')
    if (events.length) projectInitiative(events)
  } catch (error) { throw new InitiativeFileError(file, [(error as Error).message]) }
  return { events, bytes, version: hash(bytes) }
}

export function projectInitiative(events: readonly InitiativeEvent[]): InitiativeDoc {
  let doc: InitiativeDoc | undefined
  for (const { event } of events) {
    if (event.type === 'InitiativeCreated') { doc = InitiativeSchema.parse({ version: 1, ...event }); continue }
    if (!doc) throw new Error('initiative not created')
    switch (event.type) {
      case 'InitiativeBriefSaved': break
      case 'InitiativeInputAdded':
        if (doc.inputs.some(i => i.file === event.input.file)) throw new Error('duplicate input')
        doc.inputs.push(event.input); break
      case 'ResearchInputAccepted':
      case 'ResearchInputDiscarded': {
        const input = doc.inputs.find(i => i.file === event.file)
        if (!input?.draft) throw new Error('research input is not a draft')
        if (event.type === 'ResearchInputDiscarded') doc.inputs = doc.inputs.filter(i => i.file !== event.file)
        else doc.inputs = doc.inputs.map(i => i.file === event.file ? { ...i, draft: false } : i)
        break
      }
      case 'ResearchDomainsSet': doc.research = { domains: event.domains }; break
      case 'ResearchDomainsGranted': doc.research = { domains: [...new Set([...doc.research.domains, ...event.domains])] }; break
      case 'SlicePlanDrafted': doc.plan = { status: 'draft', approved_at: null, slices: event.slices }; break
      case 'SlicePlanEdited': doc.plan = { ...doc.plan, status: doc.plan.status === 'approved' ? 'approved' : 'draft', slices: event.slices }; break
      case 'SlicePlanApproved': doc.plan = { status: 'approved', approved_at: event.approved_at, slices: event.slices }; break
      case 'SliceChangeAssociated':
        if (!doc.plan.slices.some(s => s.id === event.slice)) throw new Error('unknown slice')
        doc.plan = { ...doc.plan, slices: doc.plan.slices.map(s => s.id === event.slice ? { ...s, change: event.change } : s) }; break
      case 'InitiativeRunRequested':
        if (doc.runs.some(run => run.id === event.run.id || run.execution_id === event.run.execution_id)) throw new Error('Duplicate initiative run')
        doc.runs.push(structuredClone(event.run)); break
      case 'InitiativeExecutionRecorded': {
        projectExecution(doc.executions, event.execution)
        const executionId = event.execution.type === 'ExecutionQueued' ? event.execution.request.id : event.execution.runId
        const execution = doc.executions.find(run => run.request.id === executionId)!
        const run = doc.runs.find(run => run.execution_id === executionId)
        if (!run) throw new Error('Execution has no initiative run')
        run.outcome = execution.outcome
        run.ended_at = execution.endedAt
        const attempt = execution.attempts.at(-1)
        if (attempt?.routing) run.routing = attempt.routing
        if (attempt?.session) run.session = attempt.session
        if (execution.reason) run.notes = execution.reason
        break
      }
      case 'InitiativeRunParametersSelected': {
        const run = doc.runs.find(run => run.id === event.runId)
        if (!run) throw new Error('Unknown initiative run')
        run.session = event.session
        run.container = event.container
        if (event.phase) run.phase = event.phase
        if (event.web_fetch !== undefined) run.web_fetch = event.web_fetch
        run.read_domains = event.read_domains
        run.validation_retry = event.validation_retry
        break
      }
      case 'InitiativeRunOutcomeRecorded': {
        const run = doc.runs.find(run => run.id === event.runId)
        if (!run || doc.executions.find(execution => execution.request.id === run.execution_id)?.attempts.at(-1)?.id !== event.attemptId) throw new Error('Outcome refers to an outdated initiative attempt')
        run.outcome = event.outcome; run.notes = event.notes; run.problems = event.problems; run.ended_at = event.at
        break
      }
      case 'InitiativeRunAbandoned': {
        const run = doc.runs.find(run => run.id === event.runId)
        if (!run) throw new Error('Unknown initiative run')
        run.outcome = 'stopped'; run.ended_at = event.at; run.notes = 'Stopped by the owner.'
        const execution=doc.executions.find(item=>item.request.id===run.execution_id)
        if(execution){execution.outcome='stopped';execution.endedAt=event.at;execution.reason='Abandoned by the owner'}
        break
      }
      case 'InitiativeRunGitRequested':
      case 'InitiativeRunGitCompleted': break
      case 'InitiativeOwnerGitRequested':
      case 'InitiativeOwnerGitCompleted':
      case 'InitiativeOwnerGitObserved': projectInitiativeOwnerGit(doc.git_effects,event);break
    }
  }
  if (!doc) throw new Error('initiative not created')
  return doc
}

// Content-addressed files are immutable source material. Mutable brief/inputs are only views.
export async function readInitiativeBlob(dir: string, blob: string): Promise<Buffer> {
  if (!Blob.safeParse(blob).success) throw new InitiativeFileError(path.join(dir, 'blobs'), ['invalid immutable blob reference'])
  const source = path.join(dir, 'blobs', blob)
  try {
    const root = path.join(await realpath(dir), 'blobs')
    const info = await lstat(source)
    if (await realpath(path.dirname(source)) !== root || !info.isFile() || info.isSymbolicLink()) throw new HttpError(409, 'unsafe_path', 'Invalid immutable input blob')
    const bytes = await readFile(source)
    if (hash(bytes) !== blob) throw new InitiativeFileError(source, ['immutable blob hash mismatch'])
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InitiativeFileError(source, ['immutable blob is missing'])
    throw error
  }
}

export async function storeInitiativeBlob(dir: string, bytes: Uint8Array | string): Promise<string> {
  const blob = hash(bytes)
  const root = path.join(dir, 'blobs')
  await mkdir(root, { recursive: true })
  if (await realpath(root) !== path.join(await realpath(dir), 'blobs')) throw new HttpError(409, 'unsafe_path', 'blobs/ escapes initiative')
  const file = path.join(root, blob)
  try {
    const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644)
    try { await handle.writeFile(bytes);await handle.chmod(0o644);await handle.sync() }finally{await handle.close()}
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await readInitiativeBlob(dir, blob)
  return blob
}

async function materialize(dir: string, relative: string, blob: string): Promise<void> {
  const bytes = await readInitiativeBlob(dir, blob)
  const file = path.join(dir, relative)
  await mkdir(path.dirname(file), { recursive: true })
  if (await realpath(path.dirname(file)) !== path.join(await realpath(dir), path.dirname(relative) === '.' ? '' : path.dirname(relative))) throw new HttpError(409, 'unsafe_path', `${relative} escapes initiative`)
  const info = await lstat(file).catch(() => null)
  if (info?.isSymbolicLink()) throw new HttpError(409, 'unsafe_path', `${relative} is a symbolic link`)
  if (info && hash(await readFile(file)) === blob) return
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, bytes)
  await chmod(tmp,0o644)
  await rename(tmp, file)
}

export async function restoreInitiativeFiles(dir: string, events: readonly InitiativeEvent[]): Promise<void> {
  const doc = projectInitiative(events)
  const brief = events.reduce<string | null>((blob, { event }) => event.type === 'InitiativeCreated' ? event.brief : event.type === 'InitiativeBriefSaved' ? event.blob : blob, null)
  if (brief) await materialize(dir, 'brief.md', brief)
  for (const input of doc.inputs) await materialize(dir, `inputs/${input.file}`, input.blob)
  const removed = new Set(events.flatMap(({ event }) => event.type === 'ResearchInputDiscarded' ? [event.file] : []))
  const inputsInfo = await lstat(path.join(dir, 'inputs')).catch(() => null)
  if (inputsInfo?.isSymbolicLink()) throw new HttpError(409, 'unsafe_path', 'inputs/ escapes initiative')
  for (const file of removed) if (!doc.inputs.some(i => i.file === file)) await rm(path.join(dir, 'inputs', file), { force: true })
}

export async function recordInitiativeEvents(dir: string, previous: InitiativeStream, payloads: readonly InitiativeEventPayload[], at: string, runs: InitiativeDoc['runs'] = [], origin: InitiativeEvent['origin'] = 'initiative-command'): Promise<InitiativeDoc> {
  return withReviewLock(path.join(dir, 'initiative.yaml'), async () => {
    if ((await readInitiativeStream(dir)).version !== previous.version) throw new HttpError(409, 'initiative_conflict', 'Initiative changed; retry command')
    const stream = previous.events[0]?.stream ?? randomUUID()
    const command = randomUUID()
    const batch = payloads.map((event, i) => prepareJournalRecord(Event, { version: 1, stream, sequence: previous.events.length + i + 1, id: randomUUID(), command, at, origin, event }))
    const events = [...previous.events, ...batch]
    const doc = projectInitiative(events)
    // Verify new source references before committing any event or touching derived views.
    for (const { event } of batch) {
      if (event.type === 'InitiativeCreated') await readInitiativeBlob(dir, event.brief)
      else if (event.type === 'InitiativeBriefSaved') await readInitiativeBlob(dir, event.blob)
      else if (event.type === 'InitiativeInputAdded') {
        const bytes = await readInitiativeBlob(dir, event.input.blob)
        if (bytes.byteLength !== event.input.bytes) throw new InitiativeFileError(path.join(dir, 'blobs', event.input.blob), ['input size does not match immutable blob'])
      }
    }
    if (batch.length) {
      const file = path.join(dir, INITIATIVE_EVENTS_FILE)
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        const separator = previous.bytes && !previous.bytes.endsWith('\n') ? '\n' : ''
        await writeFile(tmp, previous.bytes + separator + batch.map(e => `${JSON.stringify(e)}\n`).join(''))
        await chmod(tmp,0o644)
        if ((await readInitiativeStream(dir)).version !== previous.version) throw new HttpError(409, 'initiative_conflict', 'Initiative changed; retry command')
        await rename(tmp, file)
      } finally { await rm(tmp, { force: true }) }
    }
    await restoreInitiativeFiles(dir, events)
    await writeInitiativeProjection(dir, doc)
    return doc
  })
}
