import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeDomain } from './egress.ts'
import { HttpError } from './errors.ts'
import { git } from './git.ts'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import { INITIATIVE_FILE, type InitiativeDoc, type InputEntry, readInitiative, updateInitiative } from './initiative-store.ts'
import type { RunTarget } from './run-service.ts'

// Spec B §7: uploads and repo copies land in openspec/initiatives/<name>/inputs/, in git.
export const INPUT_EXTENSIONS = ['.pdf', '.md', '.txt', '.yaml', '.yml', '.json', '.png', '.jpg', '.jpeg']
export const MAX_INPUT_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_INPUT_BYTES = 100 * 1024 * 1024

export interface IncomingFile { name: string; bytes: Uint8Array; source: InputEntry['source'] }

// Security: the returned name is always a plain basename made of [A-Za-z0-9._-] with no leading
// dot — never "/", "\", "..", or a NUL byte — because it later becomes a path under inputs/.
export function sanitizeInputName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/'))
  const ext = path.extname(base).toLowerCase()
  if (!INPUT_EXTENSIONS.includes(ext)) throw new HttpError(422, 'unsupported_type', `${raw}: only ${INPUT_EXTENSIONS.join(' ')} files are accepted`)
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[.-]+/, '').slice(0, 80)
  return `${stem || 'input'}${ext}`
}

export function uniqueInputName(taken: readonly string[], name: string): string {
  const used = new Set(taken)
  if (!used.has(name)) return name
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let n = 2
  while (used.has(`${stem}-${n}${ext}`)) n += 1
  return `${stem}-${n}${ext}`
}

// Validates every file before anything is written, then names them (sanitized, unique).
export function planInputs(doc: Pick<InitiativeDoc, 'inputs'>, files: readonly IncomingFile[]): { name: string; file: IncomingFile }[] {
  const taken = doc.inputs.map((i) => i.file)
  let total = doc.inputs.reduce((n, i) => n + i.bytes, 0)
  return files.map((file) => {
    if (file.bytes.byteLength > MAX_INPUT_BYTES) throw new HttpError(413, 'input_too_large', `${file.name} is larger than 20 MB`)
    total += file.bytes.byteLength
    if (total > MAX_TOTAL_INPUT_BYTES) throw new HttpError(413, 'inputs_too_large', 'The inputs of one initiative may not exceed 100 MB')
    const name = uniqueInputName(taken, sanitizeInputName(file.name))
    taken.push(name)
    return { name, file }
  })
}

// Temp file + rename inside inputs/, after a realpath containment check.
export async function writeInputs(initiativeDir: string, planned: readonly { name: string; file: IncomingFile }[], at: string): Promise<InputEntry[]> {
  const dir = path.join(initiativeDir, 'inputs')
  await mkdir(dir, { recursive: true })
  const real = await realpath(dir)
  if (!real.startsWith(`${await realpath(initiativeDir)}${path.sep}`)) throw new HttpError(409, 'unsafe_path', 'inputs/ escapes the initiative')
  const entries: InputEntry[] = []
  for (const { name, file } of planned) {
    const target = path.join(real, name)
    const tmp = path.join(real, `.${name}.${process.pid}.tmp`)
    await writeFile(tmp, file.bytes)
    await rename(tmp, target)
    entries.push({ file: name, bytes: file.bytes.byteLength, source: file.source, added_at: at, draft: false })
  }
  return entries
}

const inside = (root: string, file: string): boolean => file === root || file.startsWith(`${root}${path.sep}`)

// "Add from repo": a regular file inside the hub or a configured repo; provenance = path + HEAD.
export async function readRepoFile(roots: readonly string[], hubRoot: string, requested: string): Promise<IncomingFile> {
  const candidate = path.resolve(hubRoot, requested)
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new HttpError(404, 'unknown_file', `No file ${requested}`)
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)))
  if (!realRoots.some((r) => r !== null && inside(r, real))) throw new HttpError(403, 'outside_repos', `${requested} is not inside the hub or a configured repo`)
  if (!(await lstat(real)).isFile()) throw new HttpError(422, 'not_a_file', `${requested} is not a regular file`)
  if ((await stat(real)).size > MAX_INPUT_BYTES) throw new HttpError(413, 'input_too_large', `${requested} is larger than 20 MB`)
  sanitizeInputName(real)
  const commit = (await git(path.dirname(real), ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim() || 'unknown'
  return { name: path.basename(real), bytes: await readFile(real), source: { kind: 'repo', path: path.relative(hubRoot, real).split(path.sep).join('/'), commit } }
}

export async function uploadInputs(target: RunTarget, files: readonly IncomingFile[], trailer: string, at: string): Promise<string[]> {
  const { wt, ini } = target
  if (files.length === 0) throw new HttpError(400, 'no_files', 'Nothing to add')
  const planned = planInputs(await readInitiative(ini.dir), files)
  const entries = await writeInputs(ini.dir, planned, at)
  await updateInitiative(ini.dir, (d) => ({ ...d, inputs: [...d.inputs, ...entries] }))
  const names = entries.map((e) => e.file)
  await commitPaths(wt.path, [...names.map((n) => `${ini.relDir}/inputs/${n}`), `${ini.relDir}/${INITIATIVE_FILE}`],
    initiativeCommitMessage(`${ini.name} — inputs: ${names.join(', ')}`, trailer))
  return names
}

function draftOf(doc: InitiativeDoc, file: string): InputEntry {
  const entry = doc.inputs.find((i) => i.file === file)
  if (!entry) throw new HttpError(404, 'unknown_input', `No input ${file}`)
  if (!entry.draft) throw new HttpError(409, 'not_a_draft', `${file} is not a research draft`)
  return entry
}

export async function acceptDraft(target: RunTarget, file: string, trailer: string): Promise<{ commit: string }> {
  const { wt, ini } = target
  const doc = await readInitiative(ini.dir)
  const entry = draftOf(doc, file)
  const topic = entry.source.kind === 'research' ? (doc.runs.find((r) => r.id === (entry.source as { run: string }).run)?.topic ?? file) : file
  await updateInitiative(ini.dir, (d) => ({ ...d, inputs: d.inputs.map((i) => (i.file === file ? { ...i, draft: false } : i)) }))
  const commit = await commitPaths(wt.path, [`${ini.relDir}/inputs/${file}`, `${ini.relDir}/${INITIATIVE_FILE}`],
    initiativeCommitMessage(`${ini.name} — research: ${topic}`, trailer))
  return { commit }
}

export async function discardDraft(target: RunTarget, file: string): Promise<void> {
  const { ini } = target
  draftOf(await readInitiative(ini.dir), file)
  await rm(path.join(ini.dir, 'inputs', file), { force: true })
  await updateInitiative(ini.dir, (d) => ({ ...d, inputs: d.inputs.filter((i) => i.file !== file) }))
}

// The domain allowlist editor (ruling 5); domain edits commit (ruling 9).
export async function setDomains(target: RunTarget, raw: readonly string[], trailer: string): Promise<string[]> {
  const { wt, ini } = target
  const domains = raw.map((d) => {
    const host = normalizeDomain(d)
    if (!host) throw new HttpError(422, 'invalid_domain', `"${d}" is not a plain hostname`)
    return host
  })
  const unique = [...new Set(domains)]
  if ((await readInitiative(ini.dir)).research.domains.join(',') === unique.join(',')) return unique
  await updateInitiative(ini.dir, (d) => ({ ...d, research: { domains: unique } }))
  await commitPaths(wt.path, [`${ini.relDir}/${INITIATIVE_FILE}`], initiativeCommitMessage(`${ini.name} — research domains`, trailer))
  return unique
}
