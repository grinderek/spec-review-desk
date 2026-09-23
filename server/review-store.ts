import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
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
})

export type ReviewDoc = z.infer<typeof ReviewSchema>
export type Entry = z.infer<typeof EntrySchema>
export type Thread = z.infer<typeof ThreadSchema>
export type Message = z.infer<typeof MessageSchema>
export type Patch = z.infer<typeof PatchSchema>
export type ApplyRun = z.infer<typeof ApplyRunSchema>
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

export async function readReview(changeDir: string): Promise<ReviewDoc> {
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

export async function writeReview(changeDir: string, doc: ReviewDoc): Promise<void> {
  const file = path.join(changeDir, REVIEW_FILE)
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, stringify(ReviewSchema.parse(doc), { lineWidth: 0 }))
  await rename(tmp, file)
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
