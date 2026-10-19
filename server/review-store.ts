import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { RoutingDecisionSchema } from './agent-routing.ts'
import { withReviewLock } from './review-lock.ts'
export { withReviewLock } from './review-lock.ts'

const PatchSchema = z.object({
  diff: z.string(),
  state: z.enum(['proposed', 'applied', 'rejected', 'stale']),
  commit: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  files: z.array(z.string()).default([]),
})
const MessageSchema = z.object({
  role: z.enum(['owner', 'agent']),
  at: z.string(),
  text: z.string(),
  note: z.string().nullable().default(null),
  patch: PatchSchema.nullable().default(null),
  // Decisions raised by this reply (server ids), the decided decisions its patch implements, and a
  // reply that failed validation twice (spec §4/§5). Omitted when absent.
  decision_ids: z.array(z.string()).optional(),
  resolves: z.array(z.string()).optional(),
  invalid: z.object({ issues: z.array(z.string()), raw: z.string() }).optional(),
})
const ThreadSchema = z.object({
  id: z.string(),
  anchor: z.enum(['scenario', 'phrase', 'change', 'apply']),
  ref: z.string(),
  status: z.enum(['open', 'answered', 'resolved']),
  messages: z.array(MessageSchema),
})
const EntrySchema = z.object({
  status: z.enum(['approved', 'changes_requested']),
  text_hash: z.string(),
  approved_commit: z.string().nullable().default(null),
  at: z.string(),
})
const ApplyRunSchema = z.object({
  id: z.string(),
  session: z.string(),
  pid: z.number().int().nullable(),
  log: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  outcome: z.enum(['running', 'done', 'stopped', 'failed', 'needs_owner']),
  // Byte offset in `log` at which the CURRENT attempt (this start, or this resume) began
  // writing. Persisted (not just kept in #follow's closure) so a server restart can still
  // finalize a dead resumed process's outcome from its own attempt only, never a previous one's.
  resume_offset: z.number().int().default(0),
  attempt_started_at: z.string().optional(),
  // True while this attempt is the one validation retry of spec §4; cleared by every owner resume.
  validation_retry: z.boolean().optional(),
  routing: RoutingDecisionSchema.optional(),
})
const DecisionOptionSchema = z.object({ id: z.string(), label: z.string(), consequence: z.string() })
const DecisionRecordSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable().default(null),
  source: z.union([
    z.object({ kind: z.literal('thread'), id: z.string() }),
    z.object({ kind: z.literal('apply'), run: z.string() }),
    z.object({ kind: z.literal('owner') }),
    // Spec B ruling 4: raised by a research, planner or author run of an initiative.
    z.object({ kind: z.literal('run'), run: z.string(), agent: z.enum(['research', 'planner', 'author']) }),
  ]),
  question: z.string(),
  scope: z.union([z.object({ kind: z.literal('scenario'), key: z.string() }), z.object({ kind: z.literal('change') })]),
  options: z.array(DecisionOptionSchema).default([]),
  recommended: z.string().nullable().default(null),
  blocking: z.boolean(),
  status: z.enum(['open', 'decided', 'recorded', 'dismissed']),
  choice: z.object({ option: z.string().nullable(), note: z.string(), at: z.string() }).nullable().default(null),
  recorded: z.object({ how: z.enum(['patch', 'decisions_md']), commit: z.string().nullable() }).nullable().default(null),
  dismissed: z.object({ reason: z.string(), at: z.string() }).nullable().default(null),
  created_at: z.string(),
  // Spec B ruling 3: the hosts a research run's fetch-domains decision asks to read.
  requested_domains: z.array(z.string()).optional(),
})
export const ReviewSchema = z.object({
  version: z.literal(1),
  agent_session: z.string().nullable().default(null),
  approved_at: z.string().nullable().default(null),
  approved_commit: z.string().nullable().default(null),
  scenarios: z.record(z.string(), EntrySchema).default({}),
  phrases: z.record(z.string(), EntrySchema).default({}),
  threads: z.array(ThreadSchema).default([]),
  apply_runs: z.array(ApplyRunSchema).default([]),
  decisions: z.array(DecisionRecordSchema).default([]),
})

export type ReviewDoc = z.infer<typeof ReviewSchema>
export type Entry = z.infer<typeof EntrySchema>
export type Thread = z.infer<typeof ThreadSchema>
export type Message = z.infer<typeof MessageSchema>
export type Patch = z.infer<typeof PatchSchema>
export type ApplyRun = z.infer<typeof ApplyRunSchema>
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>
export type Section = 'scenarios' | 'phrases'
export interface Effective {
  status: 'approved' | 'changes_requested' | 'pending'
  changedSinceApproval: boolean
  approvedCommit: string | null
}

export const REVIEW_FILE = 'review.yaml'

export class ReviewFileError extends Error {
  constructor(readonly file: string, readonly issues: string[]) {
    super(`${file}: ${issues.join('; ')}`)
  }
}

export const emptyReview = (): ReviewDoc => ReviewSchema.parse({ version: 1 })
export const newId = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`
export const nowIso = (date: Date = new Date()): string => date.toISOString()

async function readReviewSnapshot(changeDir: string): Promise<ReviewDoc> {
  const file = path.join(changeDir, REVIEW_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyReview()
    throw error
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new ReviewFileError(file, [(error as Error).message])
  }
  const result = ReviewSchema.safeParse(raw)
  if (!result.success) {
    throw new ReviewFileError(file, result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return result.data
}

export const REVIEW_EVENTS_FILE = 'review.events.jsonl'
export type ApprovalEvent =
  | { type: 'ScenarioApproved'; key: string; entry: Entry & { status: 'approved' } }
  | { type: 'ScenarioChangesRequested'; key: string; entry: Entry & { status: 'changes_requested' } }
  | { type: 'ScenarioReviewRemoved'; key: string }
  | { type: 'PhraseApproved'; key: string; entry: Entry & { status: 'approved' } }
  | { type: 'PhraseChangesRequested'; key: string; entry: Entry & { status: 'changes_requested' } }
  | { type: 'PhraseReviewRemoved'; key: string }
  | { type: 'ChangeApprovalRecorded'; at: string; commit: string }
  | { type: 'ChangeApprovalRemoved' }
export type DiscussionEvent =
  | { type: 'DiscussionOpened'; thread: Thread }
  | { type: 'DiscussionOwnerReplied'; threadId: string; message: Message }
  | { type: 'DiscussionAgentReplied'; threadId: string; message: Message; status: 'open' | 'answered' }
  | { type: 'DiscussionResolved'; threadId: string }
  | { type: 'DiscussionPatchUpdated'; threadId: string; index: number; patch: Patch }
  | { type: 'ReviewAgentSessionSet'; session: string }
export type ReviewDomainEvent = ApprovalEvent | DiscussionEvent
const ApprovalEnvelopeSchema = z.object({
  version: z.literal(2),
  stream: z.string().uuid(),
  sequence: z.number().int().positive(),
  id: z.string().uuid(),
  command: z.string().uuid(),
  at: z.string(),
  origin: z.enum(['approval-command', 'discussion-command', 'fixture']),
})
const ReviewEventSchema = z.discriminatedUnion('type', [
  ApprovalEnvelopeSchema.extend({ type: z.literal('ScenarioApproved'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('approved') }) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('ScenarioChangesRequested'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('changes_requested') }) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('ScenarioReviewRemoved'), key: z.string() }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('PhraseApproved'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('approved') }) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('PhraseChangesRequested'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('changes_requested') }) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('PhraseReviewRemoved'), key: z.string() }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('ChangeApprovalRecorded'), at: z.string(), commit: z.string() }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('ChangeApprovalRemoved') }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('DiscussionOpened'), thread: ThreadSchema }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('DiscussionOwnerReplied'), threadId: z.string(), message: MessageSchema.extend({ role: z.literal('owner') }) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('DiscussionAgentReplied'), threadId: z.string(), message: MessageSchema.extend({ role: z.literal('agent') }), status: z.enum(['open', 'answered']) }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('DiscussionResolved'), threadId: z.string() }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('DiscussionPatchUpdated'), threadId: z.string(), index: z.number().int().nonnegative(), patch: PatchSchema }).strict(),
  ApprovalEnvelopeSchema.extend({ type: z.literal('ReviewAgentSessionSet'), session: z.string() }).strict(),
])
export type ReviewEvent = z.infer<typeof ReviewEventSchema>
export interface ReviewStream { events: ReviewEvent[]; text: string; version: string }
export async function readReviewStream(changeDir: string): Promise<ReviewStream> {
  const file = path.join(changeDir, REVIEW_EVENTS_FILE)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = ''
    else throw error
  }
  try {
    const events = text.split('\n').filter((line) => line.trim()).map((line) => ReviewEventSchema.parse(JSON.parse(line)))
    let stream: string | undefined
    for (const [index, event] of events.entries()) {
      stream ??= event.stream
      if (event.stream !== stream || event.sequence !== index + 1) throw new Error(`Invalid review stream identity or sequence at event ${index + 1}`)
    }
    return { events, text, version: createHash('sha256').update(text).digest('hex') }
  }
  catch (error) { throw new ReviewFileError(file, [error instanceof Error ? error.message : String(error)]) }
}
export async function readReviewEvents(changeDir: string): Promise<ReviewEvent[]> {
  return (await readReviewStream(changeDir)).events
}
export function replayScenarioReviews(events: readonly ReviewEvent[]): ReviewDoc['scenarios'] {
  const scenarios: ReviewDoc['scenarios'] = {}
  for (const event of events) {
    if (event.type === 'ScenarioReviewRemoved') delete scenarios[event.key]
    else if (event.type === 'ScenarioApproved' || event.type === 'ScenarioChangesRequested') putEntry(scenarios, event.key, event.entry)
  }
  return scenarios
}
export async function readReview(changeDir: string): Promise<ReviewDoc> {
  const doc = await readReviewSnapshot(changeDir)
  return projectReview(doc, (await readReviewStream(changeDir)).events)
}
export function projectReview(doc: ReviewDoc, events: readonly ReviewEvent[]): ReviewDoc {
  if (!events.length && (Object.keys(doc.scenarios).length || Object.keys(doc.phrases).length || doc.approved_at || doc.approved_commit || doc.threads.length || doc.agent_session)) {
    throw new ReviewFileError(REVIEW_FILE, ['Review snapshot has no supported event history. Legacy snapshot imports are not supported.'])
  }
  const next: ReviewDoc = { ...doc, scenarios: replayScenarioReviews(events), phrases: {}, approved_at: null, approved_commit: null, threads: [], agent_session: null }
  for (const event of events) {
    if (event.type === 'PhraseReviewRemoved') delete next.phrases[event.key]
    else if (event.type === 'PhraseApproved' || event.type === 'PhraseChangesRequested') putEntry(next.phrases, event.key, event.entry)
    else if (event.type === 'ChangeApprovalRecorded') { next.approved_at = event.at; next.approved_commit = event.commit }
    else if (event.type === 'ChangeApprovalRemoved') { next.approved_at = null; next.approved_commit = null }
    else if (event.type === 'DiscussionOpened') {
      if (next.threads.some(t => t.id === event.thread.id)) throw new ReviewFileError(REVIEW_EVENTS_FILE, ['Duplicate discussion id'])
      next.threads.push(structuredClone(event.thread))
    }
    else if (event.type === 'ReviewAgentSessionSet') next.agent_session = event.session
    else if (event.type === 'DiscussionOwnerReplied' || event.type === 'DiscussionAgentReplied' || event.type === 'DiscussionResolved' || event.type === 'DiscussionPatchUpdated') {
      const thread = next.threads.find(t => t.id === event.threadId)
      if (!thread) throw new ReviewFileError(REVIEW_EVENTS_FILE, [`Event refers to missing discussion ${event.threadId}`])
      if (event.type === 'DiscussionResolved') thread.status = 'resolved'
      else if (event.type === 'DiscussionPatchUpdated') {
        const message = thread.messages[event.index]
        if (!message?.patch) throw new ReviewFileError(REVIEW_EVENTS_FILE, ['Patch event refers to missing patch'])
        message.patch = structuredClone(event.patch)
      } else {
        thread.messages.push(structuredClone(event.message))
        thread.status = event.type === 'DiscussionOwnerReplied' ? 'open' : event.status
      }
    }
  }
  if (doc.threads.some(t => !next.threads.some(recorded => recorded.id === t.id)) || (doc.agent_session && !events.some(e => e.type === 'ReviewAgentSessionSet'))) {
    throw new ReviewFileError(REVIEW_FILE, ['Discussion snapshot has no supported event history. Legacy snapshot imports are not supported.'])
  }
  return next
}
function putEntry(entries: Record<string, Entry>, key: string, entry: Entry): void {
  Object.defineProperty(entries, key, { value: entry, writable: true, configurable: true, enumerable: true })
}
function approvalState(doc: ReviewDoc) {
  return { scenarios: doc.scenarios, phrases: doc.phrases, approved_at: doc.approved_at, approved_commit: doc.approved_commit, threads: doc.threads, agent_session: doc.agent_session }
}
async function replaceFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  try { await writeFile(tmp, text); await rename(tmp, file) }
  finally { await rm(tmp, { force: true }) }
}
export async function writeReview(changeDir: string, doc: ReviewDoc): Promise<void> {
  return withReviewLock(changeDir, () => writeReviewSnapshotMutation(changeDir, doc))
}
async function writeReviewSnapshotMutation(changeDir: string, doc: ReviewDoc): Promise<void> {
  const next = ReviewSchema.parse(doc)
  const stream = await readReviewStream(changeDir)
  const previous = projectReview(await readReviewSnapshot(changeDir), stream.events)
  if (!isDeepStrictEqual(approvalState(next), approvalState(previous))) {
    throw new ReviewFileError(path.join(changeDir, REVIEW_FILE), ['Journaled review state can only be changed by an explicit domain command.'])
  }
  await commitReviewEvents(changeDir, stream, [])
  // Snapshot mutations persist only fields not yet migrated to the journal.
  await replaceFile(path.join(changeDir, REVIEW_FILE), stringify(next, { lineWidth: 0 }))
}

// All explicit review domain commands commit through this path.
// The caller holds withReviewLock from loading history through projection writing.
async function commitReviewEvents(changeDir: string, expected: ReviewStream, events: readonly ReviewEvent[]): Promise<ReviewEvent[]> {
  if ((await readReviewStream(changeDir)).version !== expected.version) {
    throw new ReviewFileError(path.join(changeDir, REVIEW_EVENTS_FILE), ['Review history changed while the command was being prepared. Retry the command.'])
  }
  if (!events.length) return expected.events
  const prefix = expected.text + (expected.text && !expected.text.endsWith('\n') ? '\n' : '')
  await replaceFile(path.join(changeDir, REVIEW_EVENTS_FILE), prefix + events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return [...expected.events, ...events]
}

export async function recordReviewEvents(changeDir: string, decide: (previous: ReviewDoc) => Promise<{ events: ReviewDomainEvent[]; review?: ReviewDoc; verify?: () => Promise<void> }>, origin: 'approval-command' | 'discussion-command' | 'fixture' = 'discussion-command'): Promise<void> {
  await withReviewLock(changeDir, async () => {
    const stream = await readReviewStream(changeDir)
    const previous = projectReview(await readReviewSnapshot(changeDir), stream.events)
    const decision = await decide(structuredClone(previous))
    const streamId = stream.events[0]?.stream ?? randomUUID()
    const command = randomUUID()
    const events: ReviewEvent[] = decision.events.map((event, index) => ReviewEventSchema.parse({ ...event,
      version: 2, stream: streamId, sequence: stream.events.length + index + 1,
      id: randomUUID(), command, at: 'at' in event ? event.at : nowIso(), origin }))
    await decision.verify?.()
    const mixed = ReviewSchema.parse(decision.review ?? previous)
    if (!isDeepStrictEqual(approvalState(mixed), approvalState(previous))) throw new ReviewFileError(REVIEW_FILE, ['Command mixed state cannot alter journaled fields'])
    const next = projectReview(mixed, [...stream.events, ...events])
    await commitReviewEvents(changeDir, stream, events)
    await replaceFile(path.join(changeDir, REVIEW_FILE), stringify(next, { lineWidth: 0 }))
  })
}

export function updateReview(changeDir: string, mutate: (doc: ReviewDoc) => ReviewDoc): Promise<ReviewDoc> {
  return withReviewLock(changeDir, async () => {
    const next = mutate(await readReview(changeDir))
    await writeReview(changeDir, next)
    return next
  })
}

export function effectiveStatus(entry: Entry | undefined, currentHash: string): Effective {
  if (!entry) return { status: 'pending', changedSinceApproval: false, approvedCommit: null }
  if (entry.text_hash !== currentHash) {
    return { status: 'pending', changedSinceApproval: entry.status === 'approved', approvedCommit: entry.approved_commit }
  }
  return { status: entry.status, changedSinceApproval: false, approvedCommit: entry.approved_commit }
}

export function findThread(doc: ReviewDoc, id: string): Thread {
  const thread = doc.threads.find((t) => t.id === id)
  if (!thread) throw new Error(`unknown thread ${id}`)
  return thread
}

export function upsertApplyRun(doc: ReviewDoc, run: ApplyRun): ReviewDoc {
  const exists = doc.apply_runs.some((r) => r.id === run.id)
  return { ...doc, apply_runs: exists ? doc.apply_runs.map((r) => (r.id === run.id ? run : r)) : [...doc.apply_runs, run] }
}

export function orphanKeys(
  doc: ReviewDoc,
  scenarioKeys: readonly string[],
  phraseKeys: readonly string[],
): { scenarios: string[]; phrases: string[] } {
  const scenarios = new Set(scenarioKeys)
  const phrases = new Set(phraseKeys)
  return {
    scenarios: Object.keys(doc.scenarios).filter((k) => !scenarios.has(k)),
    phrases: Object.keys(doc.phrases).filter((k) => !phrases.has(k)),
  }
}

export const recordApprovalEvents = (changeDir: string, decide: (previous: ReviewDoc) => Promise<{ events: ReviewDomainEvent[]; verify?: () => Promise<void> }>, origin: 'approval-command' | 'fixture' = 'approval-command') => recordReviewEvents(changeDir, decide, origin)
