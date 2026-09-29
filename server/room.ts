import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import type { InitiativeDoc, RunKind } from './initiative-store.ts'
import type { SliceStatus } from './slice-plan.ts'

// Spec B §5.1: the room is the only thing an agent sees — copied (never linked) per run.
export interface RoomInput {
  worktree: string
  initiativeDir: string
  doc: InitiativeDoc
  kind: RunKind
  statuses: Readonly<Record<string, SliceStatus>>
  target?: { sliceId: string; notes: string; change: string }
}

const SLICE_FILES = ['proposal.md', 'decisions.md']
const SLICE_DIRS = ['specs', 'features']
// The Desk's own method — Gherkin + event sourcing + full-stack checks — goes into every planner
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
  if (input.kind !== 'research') {
    if ((await kind(path.join(ini, 'decisions.md'))) === 'file') add(path.join(ini, 'decisions.md'), 'initiative/decisions.md')
    texts.push(['initiative/plan.yaml', planYaml(input)])
    for (const change of earlierChanges(input)) {
      const dir = path.join(input.worktree, 'openspec', 'changes', change)
      for (const f of SLICE_FILES) if ((await kind(path.join(dir, f))) === 'file') add(path.join(dir, f), `slices/${change}/${f}`)
      for (const d of SLICE_DIRS) {
        for (const rel of await walk(path.join(dir, d), () => true)) add(path.join(dir, d, rel), `slices/${change}/${d}/${rel}`)
      }
    }
    const features = path.join(input.worktree, 'features')
    for (const rel of await walk(features, (r) => r.endsWith('.feature') || r === 'STEPS.md')) add(path.join(features, rel), `corpus/features/${rel}`)
    const specs = path.join(input.worktree, 'openspec', 'specs')
    for (const rel of await walk(specs, () => true)) add(path.join(specs, rel), `corpus/specs/${rel}`)
    if ((await kind(METHOD_DOC)) === 'file') add(METHOD_DOC, 'method/bdd-event-sourcing.md')
    const claudeMd = (await kind(path.join(input.worktree, 'CLAUDE.md'))) === 'file' ? await readFile(path.join(input.worktree, 'CLAUDE.md'), 'utf8') : ''
    const section = extractSection(claudeMd, 'Spec-driven work')
    if (section) texts.push(['method/spec-driven-work.md', section])
    const testing = path.join(input.worktree, '.claude', 'rules', 'testing.md')
    if ((await kind(testing)) === 'file') add(testing, 'method/testing.md')
    const schema = path.join(input.worktree, 'openspec', 'schemas', 'behavior-driven')
    for (const rel of await walk(schema, () => true)) add(path.join(schema, rel), `method/schema/${rel}`)
  }
  for (const [from, to] of copies) {
    await mkdir(path.dirname(path.join(room, to)), { recursive: true })
    await copyFile(from, path.join(room, to))
  }
  for (const [to, text] of texts) {
    await mkdir(path.dirname(path.join(room, to)), { recursive: true })
    await writeFile(path.join(room, to), text)
  }
  return [...copies.map(([, to]) => to), ...texts.map(([to]) => to)].sort()
}
