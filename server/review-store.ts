import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'

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
  // True while this attempt is the one validation retry of spec §4; cleared by every owner resume.
  validation_retry: z.boolean().optional(),
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
const ReviewEventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('ScenarioApproved'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('approved') }) }).strict(),
  z.object({ version: z.literal(1), type: z.literal('ScenarioChangesRequested'), key: z.string(), entry: EntrySchema.extend({ status: z.literal('changes_requested') }) }).strict(),
  z.object({ version: z.literal(1), type: z.literal('ScenarioReviewRemoved'), key: z.string() }).strict(),
])
export type ReviewEvent = z.infer<typeof ReviewEventSchema>
export async function readReviewEvents(changeDir: string): Promise<ReviewEvent[]> {
  const file = path.join(changeDir, REVIEW_EVENTS_FILE)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try { return text.split('\n').filter((line) => line.trim()).map((line) => ReviewEventSchema.parse(JSON.parse(line))) }
  catch (error) { throw new ReviewFileError(file, [error instanceof Error ? error.message : String(error)]) }
}
export function replayScenarioReviews(events: readonly ReviewEvent[]): ReviewDoc['scenarios'] {
  const scenarios: ReviewDoc['scenarios'] = {}
  for (const event of events) {
    if (event.type === 'ScenarioReviewRemoved') delete scenarios[event.key]
    else scenarios[event.key] = event.entry
  }
  return scenarios
}
export async function readReview(changeDir: string): Promise<ReviewDoc> {
  const doc = await readReviewSnapshot(changeDir)
  const events = await readReviewEvents(changeDir)
  return events.length ? { ...doc, scenarios: replayScenarioReviews(events) } : doc
}
async function replaceFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  try { await writeFile(tmp, text); await rename(tmp, file) }
  finally { await rm(tmp, { force: true }) }
}
export async function writeReview(changeDir: string, doc: ReviewDoc): Promise<void> {
  const next = ReviewSchema.parse(doc)
  const previous = await readReview(changeDir)
  const history = await readReviewEvents(changeDir)
  const eventFor = (key: string, entry: Entry): ReviewEvent => ReviewEventSchema.parse({ version: 1, type: entry.status === 'approved' ? 'ScenarioApproved' : 'ScenarioChangesRequested', key, entry })
  const events: ReviewEvent[] = []
  for (const key of new Set([...Object.keys(previous.scenarios), ...Object.keys(next.scenarios)])) {
    if (JSON.stringify(previous.scenarios[key]) === JSON.stringify(next.scenarios[key])) continue
    const entry = next.scenarios[key]
    events.push(entry ? eventFor(key, entry) : { version: 1, type: 'ScenarioReviewRemoved', key })
  }
  if (events.length) {
    // Existing YAML approvals enter history before the first event-backed update.
    const baseline = history.length ? [] : Object.entries(previous.scenarios).map(([key, entry]) => eventFor(key, entry))
    await replaceFile(path.join(changeDir, REVIEW_EVENTS_FILE), [...history, ...baseline, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  // The journal commits first. If projection writing fails, replay retains scenario approvals.
  await replaceFile(path.join(changeDir, REVIEW_FILE), stringify(next, { lineWidth: 0 }))
}

const locks = new Map<string, Promise<unknown>>()

export function withReviewLock<T>(changeDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(changeDir) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  locks.set(changeDir, next)
  return next
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

export function setEntry(doc: ReviewDoc, section: Section, key: string, entry: Entry | null): ReviewDoc {
  const rest = Object.fromEntries(Object.entries(doc[section]).filter(([k]) => k !== key))
  return { ...doc, [section]: entry ? { ...rest, [key]: entry } : rest }
}

export function moveEntry(doc: ReviewDoc, section: Section, from: string, to: string): ReviewDoc {
  const entry = doc[section][from]
  if (!entry) throw new Error(`no ${section} entry ${from}`)
  return setEntry(setEntry(doc, section, from, null), section, to, entry)
}

export function findThread(doc: ReviewDoc, id: string): Thread {
  const thread = doc.threads.find((t) => t.id === id)
  if (!thread) throw new Error(`unknown thread ${id}`)
  return thread
}

function mapThread(doc: ReviewDoc, id: string, fn: (t: Thread) => Thread): ReviewDoc {
  findThread(doc, id)
  return { ...doc, threads: doc.threads.map((t) => (t.id === id ? fn(t) : t)) }
}

export const addThread = (doc: ReviewDoc, thread: Thread): ReviewDoc => ({ ...doc, threads: [...doc.threads, thread] })

export const appendMessage = (doc: ReviewDoc, id: string, message: Message): ReviewDoc =>
  mapThread(doc, id, (t) => ({ ...t, messages: [...t.messages, message] }))

export const setThreadStatus = (doc: ReviewDoc, id: string, status: Thread['status']): ReviewDoc =>
  mapThread(doc, id, (t) => ({ ...t, status }))

export function updatePatch(doc: ReviewDoc, id: string, index: number, change: Partial<Patch>): ReviewDoc {
  return mapThread(doc, id, (t) => ({
    ...t,
    messages: t.messages.map((m, i) => {
      if (i !== index) return m
      if (!m.patch) throw new Error(`message ${index} of ${id} has no patch`)
      return { ...m, patch: { ...m.patch, ...change } }
    }),
  }))
}

export const setAgentSession = (doc: ReviewDoc, session: string): ReviewDoc => ({ ...doc, agent_session: session })

export const recordApproval = (doc: ReviewDoc, at: string, commit: string): ReviewDoc => ({
  ...doc,
  approved_at: at,
  approved_commit: commit,
})

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
