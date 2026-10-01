import type { InitiativeSummary, InitiativeView } from '../../server/initiatives.ts'
import type { Plan, RunRecord } from '../../server/initiative-store.ts'
import type { SandboxStatus } from '../../server/sandbox.ts'
import type { SliceEdit, SliceStatus } from '../../server/slice-plan.ts'

// Pure helpers of the initiative screens (spec B §8).
export const SLICE_STATUSES: SliceStatus[] = ['planned', 'proposing', 'proposed', 'approved', 'applied']

export const toEdits = (plan: Plan): SliceEdit[] =>
  plan.slices.map((s) => ({ id: s.id, title: s.title, scope: s.scope, depends_on: [...s.depends_on] }))

export const editsChanged = (plan: Plan, edits: readonly SliceEdit[]): boolean => JSON.stringify(toEdits(plan)) !== JSON.stringify(edits)

export function moveEdit(edits: readonly SliceEdit[], index: number, delta: -1 | 1): SliceEdit[] {
  const to = index + delta
  if (to < 0 || to >= edits.length) return edits as SliceEdit[]
  const next = [...edits]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  return next
}

export function removeEdit(edits: readonly SliceEdit[], index: number): SliceEdit[] {
  const removed = edits[index]?.id
  return edits.filter((_, i) => i !== index).map((e) => ({ ...e, depends_on: e.depends_on.filter((d) => d !== removed) }))
}

export const addEdit = (edits: readonly SliceEdit[]): SliceEdit[] => [...edits, { id: null, title: '', scope: '', depends_on: [] }]

export function toggleDependency(edits: readonly SliceEdit[], index: number, id: string): SliceEdit[] {
  return edits.map((e, i) => {
    if (i !== index) return e
    return { ...e, depends_on: e.depends_on.includes(id) ? e.depends_on.filter((d) => d !== id) : [...e.depends_on, id] }
  })
}

export function statusSegments(summary: Pick<InitiativeSummary, 'slices'>): { status: SliceStatus; count: number }[] {
  return SLICE_STATUSES.map((status) => ({ status, count: summary.slices.filter((s) => s.status === status).length })).filter((s) => s.count > 0)
}

export const progressLabel = (summary: Pick<InitiativeSummary, 'applied' | 'total'>): string =>
  summary.total ? `${summary.applied}/${summary.total} applied` : 'no slice plan'

export interface PreviewFields { name: string; repoPath: string; where: 'new' | 'existing'; base: string; worktreePath: string | null }

// The live preview of what Create does (spec B §8, New feature dialog).
export function createPreview(f: PreviewFields): string[] {
  if (!f.name) return []
  const first = f.where === 'new'
    ? `git -C ${f.repoPath} worktree add .codex/worktrees/${f.name} -b plan/${f.name} ${f.base}`
    : `use the existing worktree ${f.worktreePath ?? '(pick one)'}`
  return [
    first,
    `write openspec/initiatives/${f.name}/{initiative.yaml,brief.md,inputs/}`,
    `git commit -m "docs(openspec): ${f.name} — initiative"`,
  ]
}

export type SliceCard =
  | { kind: 'ready' }
  | { kind: 'waiting'; text: string }
  | { kind: 'proposing'; runId: string | null; waiting: boolean }
  | { kind: 'done' }

export function sliceCard(view: InitiativeView, sliceId: string): SliceCard {
  const status = view.statuses[sliceId] ?? 'planned'
  if (status === 'proposing') {
    // A running author, or one waiting for the owner (final review I2).
    const run = view.doc.runs.find((r) => r.kind === 'author' && r.slice === sliceId && (r.outcome === 'running' || r.outcome === 'needs_owner'))
    return { kind: 'proposing', runId: run?.id ?? null, waiting: run?.outcome === 'needs_owner' }
  }
  if (status !== 'planned') return { kind: 'done' }
  const blocker = view.blockers[sliceId]
  return blocker ? { kind: 'waiting', text: blocker } : { kind: 'ready' }
}

export function runTitle(run: Pick<RunRecord, 'kind' | 'slice' | 'topic'>): string {
  if (run.kind === 'author') return `author · ${run.slice ?? '?'}`
  if (run.kind === 'research') return `research · ${run.topic ?? ''}`
  return 'planner'
}

// Resume is enabled when the run's blocking decisions are recorded or dismissed (spec B §4.4).
export function canResume(view: Pick<InitiativeView, 'decisions'>, run: RunRecord): boolean {
  if (run.outcome !== 'needs_owner') return false
  return view.decisions
    .filter((d) => d.source.kind === 'run' && d.source.run === run.id && d.blocking)
    .every((d) => d.status === 'recorded' || d.status === 'dismissed')
}

// Desk fixes item 4: how the input viewer shows a file (the server serves the same four kinds).
export type InputKind = 'markdown' | 'text' | 'pdf' | 'image'
export function inputKind(file: string): InputKind | null {
  const ext = /\.[^.]+$/.exec(file.toLowerCase())?.[0] ?? ''
  if (ext === '.md') return 'markdown'
  if (['.txt', '.yaml', '.yml', '.json'].includes(ext)) return 'text'
  if (ext === '.pdf') return 'pdf'
  return ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : null
}

// Controller ruling 1: a missing browser image only stops research from reading pages, so its hint
// belongs on the Research tab, not in the initiative's "sandbox not ready" banner.
export function researchBrowserHint(sandbox: SandboxStatus | undefined): string | null {
  if (!sandbox?.browserFix) return null
  return `Research can search, but reading pages needs the research browser. ${sandbox.browserFix}`
}
