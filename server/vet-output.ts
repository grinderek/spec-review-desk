import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { type Catalog, emptyCatalog, parseCatalog } from './catalog.ts'
import { CHANGE_ROOT, archiveChangeDir, changeDir, validateChangePackageSources } from './change-package.ts'
import { findSecrets, maskSecrets } from './secret-scan.ts'

// Spec B §6: nothing the author wrote touches the worktree before every rule here holds.
export const MAX_FILES = 200
export const MAX_BYTES = 5 * 1024 * 1024
const EXTENSIONS = ['.md', '.feature', '.yaml']
// The Desk writes these itself (review state, owner decisions); an author never may.
const DESK_FILES = ['review.yaml', 'review.events.jsonl', 'decisions.md']

export interface VetInput { out: string; change: string; worktree: string; token: string | null }
export interface VetResult { problems: string[]; files: string[]; scenarioKeys: string[] }
interface Entry { rel: string; kind: 'file' | 'symlink' | 'other'; bytes: number }

async function entries(dir: string, prefix = ''): Promise<Entry[]> {
  const out: Entry[] = []
  for (const name of (await readdir(dir)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name
    const s = await lstat(path.join(dir, name))
    if (s.isSymbolicLink()) out.push({ rel, kind: 'symlink', bytes: 0 })
    else if (s.isDirectory()) out.push(...(await entries(path.join(dir, name), rel)))
    else out.push({ rel, kind: s.isFile() ? 'file' : 'other', bytes: s.size })
  }
  return out
}

async function layoutProblems(out: string, change: string): Promise<string[]> {
  const expected = ['desk', CHANGE_ROOT, `${CHANGE_ROOT}/${change}`]
  const problems: string[] = []
  for (const [i, dir] of ['', ...expected.slice(0, 2)].entries()) {
    if (dir) {
      const s = await lstat(path.join(out, dir)).catch(() => null)
      if (s?.isSymbolicLink()) return [`${dir}: symlinks are not allowed`]
    }
    const names = (await readdir(path.join(out, dir)).catch(() => [] as string[])).sort()
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name
      if (rel !== expected[i]) problems.push(`the output must contain only ${CHANGE_ROOT}/${change}/ - found ${rel}`)
    }
  }
  if (problems.length) return problems
  const top = await lstat(path.join(out, expected[2]!)).catch(() => null)
  return top?.isDirectory() && !top.isSymbolicLink() ? [] : [`the output must contain ${CHANGE_ROOT}/${change}/`]
}

function fileProblems(list: readonly Entry[]): string[] {
  const problems = list.flatMap((e) => {
    if (e.kind === 'symlink') return [`${e.rel}: symlinks are not allowed`]
    if (e.kind === 'other') return [`${e.rel}: not a regular file`]
    if (e.rel.split('/').some((s) => s.startsWith('.'))) return [`${e.rel}: hidden files are not allowed`]
    if (DESK_FILES.includes(e.rel)) return [`${e.rel}: written by the Desk, never by the author`]
    return EXTENSIONS.includes(path.extname(e.rel)) ? [] : [`${e.rel}: only .md, .feature and .yaml files are allowed`]
  })
  const bytes = list.reduce((n, e) => n + e.bytes, 0)
  return [
    ...problems,
    ...(list.length > MAX_FILES ? [`${list.length} files - at most ${MAX_FILES}`] : []),
    ...(bytes > MAX_BYTES ? [`total size ${bytes} bytes - at most ${MAX_BYTES}`] : []),
  ]
}

async function exists(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null)) !== null
}

async function catalogAt(file: string): Promise<Catalog> {
  try {
    return parseCatalog(await readFile(file, 'utf8'))
  } catch {
    return emptyCatalog()
  }
}

// The same >= 8-character piece rule as every other committed surface (final review I3): per file,
// and over all files joined in order, so pieces spread across files - or across a file boundary -
// are caught too.
function secretKinds(text: string, token: string | null): string[] {
  const whole = findSecrets(text, token)
  if (whole.length) return whole
  return maskSecrets(text, token).secret ? ['a piece of the OAuth token'] : []
}

async function secretProblems(dir: string, files: readonly string[], token: string | null): Promise<string[]> {
  const texts = await Promise.all(files.map((rel) => readText(path.join(dir, rel))))
  const perFile = files.flatMap((rel, i) => {
    const kinds = secretKinds(texts[i]!, token)
    return kinds.length ? [`${rel}: contains a secret (${kinds.join(', ')})`] : []
  })
  if (perFile.length) return perFile
  const joined = secretKinds(texts.join(''), token)
  return joined.length ? [`the files together contain a secret split across them (${joined.join(', ')})`] : []
}

async function readText(file:string):Promise<string> {
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await readFile(file))
}
async function contentProblems(dir:string,files:readonly string[],input:VetInput):Promise<{problems:string[];keys:string[]}> {
  const problems:string[]=[]
  if(await exists(changeDir(input.worktree,input.change))||await exists(archiveChangeDir(input.worktree,input.change)))problems.push(`${input.change} already exists in the worktree`)
  problems.push(...await secretProblems(dir,files,input.token))
  const approvedCatalog=await catalogAt(path.join(input.worktree,'features/STEPS.md'))
  const sources=await Promise.all(files.map(async file=>({file,source:await readText(path.join(dir,file))})))
  const parsed=validateChangePackageSources(sources,{approvedCatalog})
  problems.push(...parsed.problems.map(problem=>`${problem.file}: ${problem.message}`))
  return {problems,keys:parsed.contracts.map(contract=>contract.key)}
}

export async function vetAuthorOutput(input: VetInput): Promise<VetResult> {
  try { changeDir(input.out,input.change) }catch(error){return {problems:[(error as Error).message],files:[],scenarioKeys:[]}}
  const layout = await layoutProblems(input.out, input.change)
  if (layout.length) return { problems: layout, files: [], scenarioKeys: [] }
  const dir = changeDir(input.out,input.change)
  const list = await entries(dir)
  const files = list.filter((e) => e.kind === 'file').map((e) => e.rel)
  const structural = fileProblems(list)
  if (structural.length) return { problems: structural, files, scenarioKeys: [] }
  try {
    const content=await contentProblems(dir,files,input)
    return {problems:content.problems,files,scenarioKeys:content.keys}
  }catch(error){return {problems:[(error as Error).message],files,scenarioKeys:[]}}
}
