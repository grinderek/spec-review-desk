import { archiveChangeDir, changeDir, CHANGE_FILE, ChangePackageError, loadChangePackage, parseNativeContract } from './change-package.ts'
import { renderChangeDocumentation, renderContractDocumentation } from './contract-docs.ts'
import { renderDecisionContext } from './decisions-md.ts'
import { readReview } from './review-store.ts'
import { emptyCatalog, parseCatalog } from './catalog.ts'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import type { InitiativeDoc, RunKind } from './initiative-store.ts'
import type { SliceStatus } from './slice-plan.ts'
import { readImplementation, implementationUrl } from './existing-process.ts'
import { worktreeId } from './discovery.ts'

// Spec B §5.1: the room is the only thing an agent sees - copied (never linked) per run.
export interface RoomInput {
  worktree: string
  initiativeDir: string
  doc: InitiativeDoc
  kind: RunKind
  statuses: Readonly<Record<string, SliceStatus>>
  target?: { sliceId: string; notes: string; change: string }
}

const SLICE_FILES = [CHANGE_FILE,'proposal.md']
const SLICE_DIRS = ['features']
// The Desk's own method - Gherkin + event sourcing + full-stack checks - goes into every planner
// and author room next to the repository's rules, so the agents write to the same shape the Desk
// checks (vet-output.ts, shape.ts).
export const METHOD_DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'method', 'bdd-event-sourcing.md')

async function kind(file: string): Promise<'file' | 'dir' | 'other' | null> {
  try {
    const s = await lstat(file)
    return s.isSymbolicLink() ? 'other' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'
  } catch {
    return null
  }
}

// Regular files only; a symlink (file or directory) is never followed or copied.
async function walk(dir: string, filter: (rel: string) => boolean, prefix = ''): Promise<string[]> {
  if ((await kind(dir)) !== 'dir') return []
  const out: string[] = []
  for (const entry of (await readdir(dir)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry
    const k = await kind(path.join(dir, entry))
    if (k === 'dir') out.push(...(await walk(path.join(dir, entry), filter, rel)))
    else if (k === 'file' && filter(rel)) out.push(rel)
  }
  return out
}

export function extractSection(markdown: string, title: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim() === title)
  if (start === -1) return null
  const level = /^#+/.exec(lines[start]!)![0].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => {
    const m = /^(#{1,6})\s/.exec(l)
    return m !== null && m[1]!.length <= level
  })
  const body = [lines[start]!, ...(end === -1 ? rest : rest.slice(0, end))].join('\n').replace(/\s+$/, '')
  return `${body}\n`
}

function planYaml(input: RoomInput): string {
  return stringify({
    initiative: input.doc.name,
    title: input.doc.title,
    status: input.doc.plan.status,
    target: input.target?.sliceId ?? null,
    change: input.target?.change ?? null,
    notes: input.target?.notes ?? null,
    slices: input.doc.plan.slices.map((s) => ({ ...s, status: input.statuses[s.id] ?? 'planned' })),
  }, { lineWidth: 0 })
}

// Slices whose change the agent may read: all proposed ones for the planner, the ones before the
// target for the author (never design.md, tasks.md, RESULT.md or review.yaml).
function earlierChanges(input: RoomInput): string[] {
  const slices = input.doc.plan.slices
  const until = input.target ? slices.findIndex((s) => s.id === input.target!.sliceId) : slices.length
  return slices.slice(0, until === -1 ? slices.length : until).flatMap((s) => (s.change ? [s.change] : []))
}

export async function assembleRoom(room: string, input: RoomInput): Promise<string[]> {
  const copies: [string, string][] = []
  const add = (from: string, to: string): void => {
    copies.push([from, to])
  }
  const ini = input.initiativeDir
  if ((await kind(path.join(ini, 'brief.md'))) === 'file') add(path.join(ini, 'brief.md'), 'initiative/brief.md')
  for (const entry of input.doc.inputs.filter((i) => !i.draft)) {
    const file = path.join(ini, 'inputs', entry.file)
    if ((await kind(file)) === 'file') add(file, `initiative/inputs/${entry.file}`)
  }
  const texts: [string, string][] = []
  if (input.doc.existingProcess && input.kind !== 'research') {
    const snapshot = await readImplementation(ini, input.doc)
    const sources = snapshot.sources.map((source, index) => ({ ...source, files: source.files.map(file => {
      const location = `implementation/${index}/${file.path}`
      texts.push([location, file.content])
      return { path: file.path, location, hash: file.hash, lines: file.lines, url: implementationUrl(worktreeId(input.worktree), input.doc.name, source.repo, file.path) }
    }) }))
    texts.push(['implementation/index.json', JSON.stringify({ version: 1, process: input.doc.existingProcess, sources }, null, 2)])
  }
  if (input.kind !== 'research') {
    texts.push(['initiative/decisions.md',renderDecisionContext(await readReview(ini),input.doc.name)])
    const catalogSource=(await kind(path.join(input.worktree,'features/STEPS.md')))==='file'?await readFile(path.join(input.worktree,'features/STEPS.md'),'utf8'):null
    const approvedCatalog=catalogSource?parseCatalog(catalogSource):emptyCatalog()
    texts.push(['initiative/plan.yaml', planYaml(input)])
    for (const change of earlierChanges(input)) {
      const active=changeDir(input.worktree,change)
      const dir=(await kind(active))==='dir'?active:archiveChangeDir(input.worktree,change)
      const parsed=await loadChangePackage(dir,{approvedCatalog})
      if(!parsed.valid)throw new ChangePackageError(parsed.problems)
      texts.push([`slices/${change}/contracts.md`,renderChangeDocumentation(parsed)])
      texts.push([`slices/${change}/decisions.md`,renderDecisionContext(await readReview(dir),change)])
      for (const f of SLICE_FILES) if ((await kind(path.join(dir, f))) === 'file') add(path.join(dir, f), `slices/${change}/${f}`)
      for (const d of SLICE_DIRS) {
        for (const rel of await walk(path.join(dir,d),rel=>rel.endsWith('.feature')||rel.endsWith('.desk.yaml')||rel==='NEW_STEPS.md')) add(path.join(dir, d, rel), `slices/${change}/${d}/${rel}`)
      }
    }
    const features = path.join(input.worktree, 'features')
    for (const rel of await walk(features, (r) => r.endsWith('.feature') || r.endsWith('.desk.yaml') || r === 'STEPS.md')) add(path.join(features, rel), `corpus/features/${rel}`)
    const corpusFiles=[]
    for(const rel of await walk(features,relative=>relative.endsWith('.feature')||relative.endsWith('.desk.yaml'))) {
      corpusFiles.push(parseNativeContract(await readFile(path.join(features,rel),'utf8'),`features/${rel}`))
    }
    texts.push(['corpus/contracts.md',renderContractDocumentation(corpusFiles)])
    if ((await kind(METHOD_DOC)) === 'file') add(METHOD_DOC, 'method/bdd-event-sourcing.md')
    // Prefer Codex project instructions; retain the old files as migration inputs.
    const agents = path.join(input.worktree, 'AGENTS.md')
    const legacy = path.join(input.worktree, 'CLAUDE.md')
    const rulesFile = (await kind(agents)) === 'file' ? agents : legacy
    const rules = (await kind(rulesFile)) === 'file' ? await readFile(rulesFile, 'utf8') : ''
    const section = extractSection(rules, 'Spec-driven work')
    if (rules) texts.push(['method/spec-driven-work.md', section || rules])
    const codexTesting = path.join(input.worktree, '.agents', 'rules', 'testing.md')
    const testing = (await kind(codexTesting)) === 'file' ? codexTesting : path.join(input.worktree, '.claude', 'rules', 'testing.md')
    if ((await kind(testing)) === 'file') add(testing, 'method/testing.md')

  }
  async function roomDir(dir: string): Promise<void> {
    const root = path.resolve(room)
    const target = path.resolve(dir)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Room path escapes its root')
    await mkdir(target, { recursive: true })
    for (let at = target; ; at = path.dirname(at)) {
      await chmod(at, 0o755)
      if (at === root) break
    }
  }
  await roomDir(room)
  for (const [from, to] of copies) {
    await roomDir(path.dirname(path.join(room, to)))
    await copyFile(from, path.join(room, to))
    await chmod(path.join(room, to), 0o644)
  }
  for (const [to, text] of texts) {
    await roomDir(path.dirname(path.join(room, to)))
    await writeFile(path.join(room, to), text, { mode: 0o644 })
    await chmod(path.join(room, to), 0o644)
  }
  return [...copies.map(([, to]) => to), ...texts.map(([to]) => to)].sort()
}
