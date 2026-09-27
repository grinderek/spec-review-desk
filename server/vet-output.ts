import { cp, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse, YAMLParseError } from 'yaml'
import { FeatureParseError, parseFeature, unclassified } from './gherkin.ts'
import { run } from './git.ts'
import { checkJoinKey, specTitles } from './joinkey.ts'
import { findSecrets, maskSecrets } from './secret-scan.ts'

// Spec B §6: nothing the author wrote touches the worktree before every rule here holds.
export const MAX_FILES = 200
export const MAX_BYTES = 5 * 1024 * 1024
const EXTENSIONS = ['.md', '.feature', '.yaml']
// The Desk writes these itself (review state, owner decisions); an author never may.
const DESK_FILES = ['review.yaml', 'decisions.md']

export interface VetInput { out: string; change: string; worktree: string; openspecBin: string; token: string | null }
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
  const expected = ['openspec', 'openspec/changes', `openspec/changes/${change}`]
  const problems: string[] = []
  for (const [i, dir] of ['', ...expected.slice(0, 2)].entries()) {
    if (dir) {
      const s = await lstat(path.join(out, dir)).catch(() => null)
      if (s?.isSymbolicLink()) return [`${dir}: symlinks are not allowed`]
    }
    const names = (await readdir(path.join(out, dir)).catch(() => [] as string[])).sort()
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name
      if (rel !== expected[i]) problems.push(`the output must contain only openspec/changes/${change}/ — found ${rel}`)
    }
  }
  if (problems.length) return problems
  const top = await lstat(path.join(out, expected[2]!)).catch(() => null)
  return top?.isDirectory() && !top.isSymbolicLink() ? [] : [`the output must contain openspec/changes/${change}/`]
}

function fileProblems(list: readonly Entry[]): string[] {
  const problems = list.flatMap((e) => {
    if (e.kind === 'symlink') return [`${e.rel}: symlinks are not allowed`]
    if (e.kind === 'other') return [`${e.rel}: not a regular file`]
    if (e.rel !== '.openspec.yaml' && e.rel.split('/').some((s) => s.startsWith('.'))) return [`${e.rel}: hidden files are not allowed`]
    if (DESK_FILES.includes(e.rel)) return [`${e.rel}: written by the Desk, never by the author`]
    return EXTENSIONS.includes(path.extname(e.rel)) ? [] : [`${e.rel}: only .md, .feature and .yaml files are allowed`]
  })
  const bytes = list.reduce((n, e) => n + e.bytes, 0)
  return [
    ...problems,
    ...(list.length > MAX_FILES ? [`${list.length} files — at most ${MAX_FILES}`] : []),
    ...(bytes > MAX_BYTES ? [`total size ${bytes} bytes — at most ${MAX_BYTES}`] : []),
  ]
}

async function exists(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null)) !== null
}

async function schemaProblem(dir: string, files: readonly string[]): Promise<string | null> {
  if (!files.includes('.openspec.yaml')) return '.openspec.yaml must say schema: behavior-driven'
  try {
    const meta = parse(await readFile(path.join(dir, '.openspec.yaml'), 'utf8')) as { schema?: unknown } | null
    return meta?.schema === 'behavior-driven' ? null : '.openspec.yaml must say schema: behavior-driven'
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error
    return `.openspec.yaml: ${error.message.split('\n')[0]}`
  }
}

// The same >= 8-character piece rule as every other committed surface (final review I3): per file,
// and over all files joined in order, so pieces spread across files — or across a file boundary —
// are caught too.
function secretKinds(text: string, token: string | null): string[] {
  const whole = findSecrets(text, token)
  if (whole.length) return whole
  return maskSecrets(text, token).secret ? ['a piece of the OAuth token'] : []
}

async function secretProblems(dir: string, files: readonly string[], token: string | null): Promise<string[]> {
  const texts = await Promise.all(files.map((rel) => readFile(path.join(dir, rel), 'utf8')))
  const perFile = files.flatMap((rel, i) => {
    const kinds = secretKinds(texts[i]!, token)
    return kinds.length ? [`${rel}: contains a secret (${kinds.join(', ')})`] : []
  })
  if (perFile.length) return perFile
  const joined = secretKinds(texts.join(''), token)
  return joined.length ? [`the files together contain a secret split across them (${joined.join(', ')})`] : []
}

async function contentProblems(dir: string, files: readonly string[], input: VetInput): Promise<{ problems: string[]; keys: string[] }> {
  const problems: string[] = []
  const schema = await schemaProblem(dir, files)
  if (schema) problems.push(schema)
  if (await exists(path.join(input.worktree, 'openspec', 'changes', input.change))) problems.push(`${input.change} already exists in the worktree`)
  problems.push(...(await secretProblems(dir, files, input.token)))
  const keys: string[] = []
  const titles: string[] = []
  for (const rel of files.filter((f) => f.startsWith('features/') && f.endsWith('.feature'))) {
    try {
      const feature = parseFeature(await readFile(path.join(dir, rel), 'utf8'), rel, unclassified)
      keys.push(...feature.scenarios.map((s) => s.key))
      titles.push(...feature.scenarios.map((s) => s.title))
    } catch (error) {
      if (!(error instanceof FeatureParseError)) throw error
      problems.push(`${rel}: ${error.message}`)
    }
  }
  const specs = (await Promise.all(files.filter((f) => f.startsWith('specs/') && f.endsWith('.md')).map(async (f) => specTitles(await readFile(path.join(dir, f), 'utf8'))))).flat()
  const join = checkJoinKey(specs, titles)
  if (!join.ok) {
    const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
    problems.push(
      `join key: ${count(join.missingInFeatures.length, 'spec title', 'spec titles')} without a scenario, ` +
        `${count(join.missingInSpecs.length, 'scenario', 'scenarios')} without a spec line, ${count(join.duplicateTitles.length, 'duplicate title', 'duplicate titles')}`,
    )
  }
  return { problems, keys }
}

// `openspec validate --strict` runs in a scratch copy of the worktree's openspec/ — never the real one.
async function validateProblems(dir: string, input: VetInput): Promise<string[]> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sr-validate-'))
  try {
    const source = path.join(input.worktree, 'openspec')
    if (await exists(source)) await cp(source, path.join(scratch, 'openspec'), { recursive: true, verbatimSymlinks: true })
    await cp(dir, path.join(scratch, 'openspec', 'changes', input.change), { recursive: true })
    const result = await run(input.openspecBin, ['validate', input.change, '--strict'], { cwd: scratch, timeoutMs: 120_000, allowFailure: true })
    if (result.code === 0) return []
    return [`openspec validate --strict failed: ${`${result.stdout}\n${result.stderr}`.trim().slice(0, 1500)}`]
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function vetAuthorOutput(input: VetInput): Promise<VetResult> {
  const layout = await layoutProblems(input.out, input.change)
  if (layout.length) return { problems: layout, files: [], scenarioKeys: [] }
  const dir = path.join(input.out, 'openspec', 'changes', input.change)
  const list = await entries(dir)
  const files = list.filter((e) => e.kind === 'file').map((e) => e.rel)
  const structural = fileProblems(list)
  if (structural.length) return { problems: structural, files, scenarioKeys: [] }
  const content = await contentProblems(dir, files, input)
  if (content.problems.length) return { problems: content.problems, files, scenarioKeys: content.keys }
  return { problems: await validateProblems(dir, input), files, scenarioKeys: content.keys }
}

export async function moveChange(out: string, change: string, worktree: string): Promise<string> {
  const target = path.join(worktree, 'openspec', 'changes', change)
  await cp(path.join(out, 'openspec', 'changes', change), target, { recursive: true, errorOnExist: true, force: false })
  return target
}
