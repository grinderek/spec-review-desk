import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { HttpError } from './errors.ts'
import { ReviewFileError, withReviewLock } from './review-store.ts'

// openspec/initiatives/<name>/initiative.yaml (spec B §3). Slice statuses are derived, never stored.
export const INITIATIVE_FILE = 'initiative.yaml'
export const INITIATIVE_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/
// Every persisted field that becomes a filesystem path (or a path-shaped argv) is constrained here,
// so a hand-edited, merged or corrupted initiative.yaml fails as 409 review_invalid instead of
// driving a read, copy or recursive delete outside its directory (final review I4).
export const RUN_ID = /^r_[0-9a-f]{8}$/
export const CHANGE_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/
// A sanitized input name (inputs.ts sanitizeInputName): a plain basename, no "/", no leading dot.
export const INPUT_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/
export const runLogPath = (id: string): string => `.spec-review/runs/${id}.ndjson`

const InputSourceSchema = z.union([
  z.object({ kind: z.literal('upload') }),
  z.object({ kind: z.literal('repo'), path: z.string(), commit: z.string() }),
  z.object({ kind: z.literal('research'), run: z.string().regex(RUN_ID), domains: z.array(z.string()).default([]) }),
])
const InputSchema = z.object({
  file: z.string().regex(INPUT_FILE),
  bytes: z.number().int().nonnegative(),
  source: InputSourceSchema,
  added_at: z.string(),
  // A research document stays a draft — excluded from every room — until the owner accepts it.
  draft: z.boolean().default(false),
})
const SliceSchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.string(),
  depends_on: z.array(z.string()).default([]),
  change: z.string().regex(CHANGE_NAME).nullable().default(null),
})
const RunSchema = z.object({
  id: z.string().regex(RUN_ID),
  kind: z.enum(['research', 'planner', 'author']),
  slice: z.string().nullable().default(null),
  topic: z.string().nullable().default(null),
  session: z.string().regex(SESSION_ID),
  container: z.string(),
  log: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  outcome: z.enum(['running', 'done', 'needs_owner', 'failed', 'stopped']),
  notes: z.string().nullable().default(null),
  // Research only: the owner's questions and the phase (search: WebSearch only; read: after the
  // fetch-domains decision) and whether WebFetch is enabled in the read phase.
  questions: z.string().optional(),
  phase: z.enum(['search', 'read']).optional(),
  web_fetch: z.boolean().optional(),
  // The domains the run's reading attempts could reach (union over its read phases): the draft's
  // provenance, also after the owner stopped reading.
  read_domains: z.array(z.string()).optional(),
  // Author only: the change name the author must write.
  change: z.string().regex(CHANGE_NAME).optional(),
  // The one validation retry of sub-project A §4 is running (cleared by an owner resume).
  validation_retry: z.boolean().optional(),
  // Validation or vetting problems of a failed run.
  problems: z.array(z.string()).optional(),
}).refine((run) => run.log === runLogPath(run.id), { path: ['log'], message: 'must be .spec-review/runs/<run id>.ndjson' })
export const InitiativeSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(INITIATIVE_NAME),
  title: z.string().min(1),
  repo: z.string().min(1),
  created_at: z.string(),
  inputs: z.array(InputSchema).default([]),
  research: z.object({ domains: z.array(z.string()).default([]) }).default({ domains: [] }),
  plan: z
    .object({
      status: z.enum(['none', 'draft', 'approved']).default('none'),
      approved_at: z.string().nullable().default(null),
      slices: z.array(SliceSchema).default([]),
    })
    .default({ status: 'none', approved_at: null, slices: [] }),
  runs: z.array(RunSchema).default([]),
})

export type InitiativeDoc = z.infer<typeof InitiativeSchema>
export type InputEntry = z.infer<typeof InputSchema>
export type Slice = z.infer<typeof SliceSchema>
export type RunRecord = z.infer<typeof RunSchema>
export type RunKind = RunRecord['kind']
export type Plan = InitiativeDoc['plan']

// A subclass, so the v1 error mapping answers 409 review_invalid naming the file and its issues.
export class InitiativeFileError extends ReviewFileError {}

export const isInitiativeName = (name: string): boolean => INITIATIVE_NAME.test(name)

export function initiativeDir(worktreePath: string, name: string): string {
  if (!isInitiativeName(name)) throw new HttpError(422, 'invalid_name', `invalid initiative name "${name}"`)
  return path.join(worktreePath, 'openspec', 'initiatives', name)
}

export const emptyInitiative = (meta: { name: string; title: string; repo: string; created_at: string }): InitiativeDoc =>
  InitiativeSchema.parse({ version: 1, ...meta })

export async function readInitiative(dir: string): Promise<InitiativeDoc> {
  const file = path.join(dir, INITIATIVE_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'unknown_initiative', `No initiative at ${dir}`)
    throw error
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new InitiativeFileError(file, [(error as Error).message])
  }
  const result = InitiativeSchema.safeParse(raw)
  if (!result.success) throw new InitiativeFileError(file, result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  return result.data
}

export const renderInitiative = (doc: InitiativeDoc): string => stringify(InitiativeSchema.parse(doc), { lineWidth: 0 })

export async function writeInitiative(dir: string, doc: InitiativeDoc): Promise<void> {
  const file = path.join(dir, INITIATIVE_FILE)
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, renderInitiative(doc))
  await rename(tmp, file)
}

// One lock per initiative.yaml, separate from the lock of the review.yaml in the same folder.
export const withInitiativeLock = <T>(dir: string, fn: () => Promise<T>): Promise<T> => withReviewLock(path.join(dir, INITIATIVE_FILE), fn)

export function updateInitiative(dir: string, mutate: (doc: InitiativeDoc) => InitiativeDoc): Promise<InitiativeDoc> {
  return withInitiativeLock(dir, async () => {
    const next = mutate(await readInitiative(dir))
    await writeInitiative(dir, next)
    return next
  })
}

export function findRun(doc: InitiativeDoc, id: string): RunRecord {
  const found = doc.runs.find((r) => r.id === id)
  if (!found) throw new HttpError(404, 'unknown_run', `No run ${id}`)
  return found
}

export function findSlice(doc: InitiativeDoc, id: string): Slice {
  const found = doc.plan.slices.find((s) => s.id === id)
  if (!found) throw new HttpError(404, 'unknown_slice', `No slice ${id}`)
  return found
}

export function upsertRun(doc: InitiativeDoc, run: RunRecord): InitiativeDoc {
  const exists = doc.runs.some((r) => r.id === run.id)
  return { ...doc, runs: exists ? doc.runs.map((r) => (r.id === run.id ? run : r)) : [...doc.runs, run] }
}
