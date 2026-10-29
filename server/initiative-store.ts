import { initiativeDir as nativeInitiativeDir } from './change-package.ts'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { HttpError } from './errors.ts'
import { ReviewFileError, withReviewLock } from './review-store.ts'
import { projectInitiative, readInitiativeStream, restoreInitiativeFiles } from './initiative-events.ts'
import { isDeepStrictEqual } from 'node:util'

export * from './initiative-model.ts'
import { InitiativeSchema, INITIATIVE_NAME, INITIATIVE_FILE, type InitiativeDoc, type RunRecord, type Slice } from './initiative-model.ts'

// A subclass, so the v1 error mapping answers 409 review_invalid naming the file and its issues.
export class InitiativeFileError extends ReviewFileError {}

export const isInitiativeName = (name: string): boolean => INITIATIVE_NAME.test(name)

export function initiativeDir(worktreePath: string, name: string): string {
  if (!isInitiativeName(name)) throw new HttpError(422, 'invalid_name', `invalid initiative name "${name}"`)
  return nativeInitiativeDir(worktreePath,name)
}

export const emptyInitiative = (meta: { name: string; title: string; repo: string; created_at: string }): InitiativeDoc =>
  InitiativeSchema.parse({ version: 1, ...meta })

export function readInitiative(dir: string): Promise<InitiativeDoc> {
  return withInitiativeLock(dir, () => readInitiativeLocked(dir))
}

async function readInitiativeLocked(dir: string): Promise<InitiativeDoc> {
  const stream = await readInitiativeStream(dir)
  if (!stream.events.length) {
    const present = await readFile(path.join(dir, INITIATIVE_FILE)).then(() => true, () => false)
    if (present) throw new InitiativeFileError(path.join(dir, INITIATIVE_FILE), ['initiative journal required; snapshot import is unsupported'])
    throw new HttpError(404, 'unknown_initiative', `No initiative at ${dir}`)
  }
  const doc = projectInitiative(stream.events)
  await restoreInitiativeFiles(dir, stream.events)
  await writeInitiativeProjection(dir, doc)
  return doc
}

export const renderInitiative = (doc: InitiativeDoc): string => stringify(InitiativeSchema.parse(doc), { lineWidth: 0 })

export async function writeInitiative(dir: string, doc: InitiativeDoc): Promise<void> {
  return withInitiativeLock(dir, async () => {
    const prior = await readInitiative(dir)
    if (!isDeepStrictEqual(prior, doc)) {
      throw new InitiativeFileError(path.join(dir, INITIATIVE_FILE), ['business state must be changed with initiative commands'])
    }
    await writeInitiativeProjection(dir, doc)
  })
}

export async function writeInitiativeProjection(dir: string, doc: InitiativeDoc): Promise<void> {
  const file = path.join(dir, INITIATIVE_FILE)
  const rendered = renderInitiative(doc)
  // Reads also repair derived views. An unchanged projection must not produce another
  // filesystem event, otherwise the live-update observer keeps refetching its own writes.
  const current = await readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (current === rendered) {
    const info = await lstat(file)
    if (info.isFile() && (info.mode & 0o7777) === 0o644) return
  }
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, rendered)
  await chmod(tmp,0o644)
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
