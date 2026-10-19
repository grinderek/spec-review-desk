import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from './errors.ts'
import { git } from './git.ts'
import { initiativeCommitMessage } from './initiative-git.ts'
import { INPUT_FILE, type InitiativeDoc, type InputEntry, readInitiative } from './initiative-store.ts'
import type { RunTarget } from './run-service.ts'
import { storeInitiativeBlob } from './initiative-events.ts'
import { executeInitiativeCommand } from './initiative-commands.ts'
import { executeInitiativeOwnerOperation, initiativeBlobOutputs, initiativeOwnerGitInput, ownerRequestHash } from './initiative-owner-effects.ts'

// Spec B §7: uploads and repo copies land in desk/initiatives/<name>/inputs/, in git.
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
  if (files.length === 0) throw new HttpError(400, 'no_files', 'Nothing to add')
  const requestHash=ownerRequestHash(files.map(file=>({name:file.name,source:file.source,hash:createHash('sha256').update(file.bytes).digest('hex')})))
  const saved=await executeInitiativeOwnerOperation(target,{operation:'inputs',requestHash,prepare:async doc=>{
    const planned=planInputs(doc,files)
    const entries:InputEntry[]=await Promise.all(planned.map(async({name,file})=>({file:name,bytes:file.bytes.byteLength,blob:await storeInitiativeBlob(target.ini.dir,file.bytes),source:file.source,added_at:at,draft:false})))
    const names=entries.map(entry=>entry.file)
    return {command:{type:'add-inputs',inputs:entries},result:{files:names},git:async next=>initiativeOwnerGitInput(target,next,'inputs',
      initiativeCommitMessage(`${target.ini.name} - inputs: ${names.join(', ')}`,trailer),
      entries.flatMap(entry=>initiativeBlobOutputs(target,entry.blob,`inputs/${entry.file}`)).filter((output,index,outputs)=>outputs.findIndex(other=>other.path===output.path)===index))}
  }})
  return saved.result.files as string[]
}

// Desk fixes item 4: the Desk shows an input (a research draft before Accept, any other input on
// demand). Text is served as plain text — the UI renders it, the browser never interprets it —
// and a PDF or an image inline with its own type.
const TEXT_INPUTS = new Set(['.md', '.txt', '.yaml', '.yml', '.json'])
const INLINE_INPUTS: Readonly<Record<string, string>> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
export interface ServedInput { file: string; bytes: Uint8Array<ArrayBuffer>; contentType: string; inline: boolean }

// Only a listed input of this initiative, only a regular file directly inside its inputs/ — never
// a symlink and never anything the name could reach outside (the name is also a sanitized basename).
export async function readInput(target: RunTarget, file: string): Promise<ServedInput> {
  const { ini } = target
  const entry = INPUT_FILE.test(file) ? (await readInitiative(ini.dir)).inputs.find((i) => i.file === file) : undefined
  if (!entry) throw new HttpError(404, 'unknown_input', `No input ${file}`)
  const ext = path.extname(entry.file).toLowerCase()
  const contentType = TEXT_INPUTS.has(ext) ? 'text/plain; charset=utf-8' : INLINE_INPUTS[ext]
  if (!contentType) throw new HttpError(415, 'unsupported_type', `${entry.file} is not a type the Desk shows`)
  const dir = path.join(ini.dir, 'inputs')
  const unsafe = new HttpError(409, 'unsafe_path', `${entry.file} is not a regular file inside the inputs of ${ini.name}`)
  // inputs/ itself must be the initiative's own directory, not a symlink to elsewhere (review fix
  // 2). Immutable content and reconstructed views remain inside this initiative.
  const root = path.join(await realpath(ini.dir), 'inputs')
  let real: string
  try {
    if ((await realpath(dir)) !== root) throw unsafe
    if ((await lstat(path.join(dir, entry.file))).isSymbolicLink()) throw unsafe
    real = await realpath(path.join(dir, entry.file))
  } catch (error) {
    if (error === unsafe) throw error
    throw new HttpError(404, 'input_missing', `${entry.file} is listed but its file is missing`)
  }
  if (path.dirname(real) !== root || !(await lstat(real)).isFile()) throw unsafe
  return { file: entry.file, bytes: new Uint8Array(await readFile(real)), contentType, inline: !TEXT_INPUTS.has(ext) }
}

function draftOf(doc: InitiativeDoc, file: string): InputEntry {
  const entry = doc.inputs.find((i) => i.file === file)
  if (!entry) throw new HttpError(404, 'unknown_input', `No input ${file}`)
  if (!entry.draft) throw new HttpError(409, 'not_a_draft', `${file} is not a research draft`)
  return entry
}

export async function acceptDraft(target: RunTarget, file: string, trailer: string): Promise<{ commit: string }> {
  const saved=await executeInitiativeOwnerOperation(target,{operation:'research-accept',requestHash:ownerRequestHash({file}),prepare:async doc=>{
    const entry=draftOf(doc,file)
    const topic=entry.source.kind==='research'?(doc.runs.find(run=>run.id===(entry.source as {run:string}).run)?.topic??file):file
    return {command:{type:'accept-input',file},result:{},git:async next=>initiativeOwnerGitInput(target,next,'research-accept',
      initiativeCommitMessage(`${target.ini.name} - research: ${topic}`,trailer),initiativeBlobOutputs(target,entry.blob,`inputs/${file}`))}
  }})
  return {commit:saved.commit!}
}

export async function discardDraft(target: RunTarget, file: string): Promise<void> {
  const { ini } = target
  await executeInitiativeCommand(ini.dir, { type: 'discard-input', file })
}

// The domain allowlist editor (ruling 5); domain edits commit (ruling 9).
export async function setDomains(target: RunTarget, raw: readonly string[], trailer: string): Promise<string[]> {
  const saved=await executeInitiativeOwnerOperation(target,{operation:'domains',requestHash:ownerRequestHash({domains:raw}),prepare:async()=>({
    command:{type:'set-domains',domains:raw},result:{},noChange:true,
    git:async next=>initiativeOwnerGitInput(target,next,'domains',initiativeCommitMessage(`${target.ini.name} - research domains`,trailer)),
  })})
  void saved
  return (await readInitiative(target.ini.dir)).research.domains
}
