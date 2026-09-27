import type { InitiativeSummary } from '../../server/initiatives.ts'
import type { Plan } from '../../server/initiative-store.ts'
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
    ? `git -C ${f.repoPath} worktree add .claude/worktrees/${f.name} -b plan/${f.name} ${f.base}`
    : `use the existing worktree ${f.worktreePath ?? '(pick one)'}`
  return [
    first,
    `write openspec/initiatives/${f.name}/{initiative.yaml,brief.md,inputs/}`,
    `git commit -m "docs(openspec): ${f.name} — initiative"`,
  ]
}
