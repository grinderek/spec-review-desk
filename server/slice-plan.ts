import { HttpError } from './errors.ts'
import type { Plan, Slice } from './initiative-store.ts'

// Pure slice-plan rules (spec B §3/§4.2/§4.3; rulings 8 and 9). Every function returns a new plan.
export interface PlannerSlice { title: string; scope: string; depends_on: number[] }
export interface SliceEdit { id: string | null; title: string; scope: string; depends_on: string[] }
export type SliceStatus = 'planned' | 'proposing' | 'proposed' | 'approved' | 'applied'
export interface SliceFacts { authorRunning: boolean; changeExists: boolean; approved: boolean; applied: boolean }

const sliceNumber = (id: string): number => Number(/^s(\d+)$/.exec(id)?.[1] ?? 0)
const nextNumber = (ids: readonly string[]): number => Math.max(0, ...ids.map(sliceNumber)) + 1

function findCycle(nodes: readonly { id: string; depends_on: readonly string[] }[]): string[] | null {
  const deps = new Map(nodes.map((n) => [n.id, n.depends_on]))
  const done = new Set<string>()
  const visit = (id: string, trail: string[]): string[] | null => {
    const at = trail.indexOf(id)
    if (at !== -1) return [...trail.slice(at), id]
    if (done.has(id)) return null
    for (const next of deps.get(id) ?? []) {
      const cycle = visit(next, [...trail, id])
      if (cycle) return cycle
    }
    done.add(id)
    return null
  }
  for (const node of nodes) {
    const cycle = visit(node.id, [])
    if (cycle) return cycle
  }
  return null
}

export function dependencyIssues(nodes: readonly { id: string; depends_on: readonly string[] }[]): string[] {
  const ids = new Set(nodes.map((n) => n.id))
  const issues = nodes.flatMap((n) => [
    ...n.depends_on.filter((d) => !ids.has(d)).map((d) => `${n.id} depends on an unknown slice ${d}`),
    ...(n.depends_on.includes(n.id) ? [`${n.id} cannot depend on itself`] : []),
  ])
  if (issues.length) return issues
  const cycle = findCycle(nodes)
  return cycle ? [`dependency cycle ${cycle.join(' → ')}`] : []
}

// The planner names dependencies by 1-based slice number (spec B §4.2: indices in range, no cycles).
export function plannerSliceIssues(slices: readonly PlannerSlice[]): string[] {
  const issues = slices.flatMap((s, i) =>
    s.depends_on.flatMap((d) => {
      if (!Number.isInteger(d) || d < 1 || d > slices.length) return [`slices[${i}].depends_on: ${d} is not a slice number (1..${slices.length})`]
      return d === i + 1 ? [`slices[${i}].depends_on: a slice cannot depend on itself`] : []
    }))
  if (issues.length) return issues
  const cycle = findCycle(slices.map((s, i) => ({ id: `s${i + 1}`, depends_on: s.depends_on.map((d) => `s${d}`) })))
  return cycle ? [`slices: dependency cycle ${cycle.join(' → ')}`] : []
}

export const slicesFromPlanner = (slices: readonly PlannerSlice[]): Slice[] =>
  slices.map((s, i) => ({ id: `s${i + 1}`, title: s.title.trim(), scope: s.scope.trim(), depends_on: [...new Set(s.depends_on)].map((d) => `s${d}`), change: null }))

function checked(slices: Slice[]): Slice[] {
  const ids = slices.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new HttpError(422, 'invalid_plan', 'slice ids must be unique')
  const issues = dependencyIssues(slices)
  if (issues.length) throw new HttpError(422, 'invalid_plan', issues.join('; '))
  return slices
}

const sameContent = (a: Pick<Slice, 'title' | 'scope' | 'depends_on'>, b: Pick<Slice, 'title' | 'scope' | 'depends_on'>): boolean =>
  a.title === b.title && a.scope === b.scope && a.depends_on.join(',') === b.depends_on.join(',')

function editDraft(plan: Plan, edits: readonly SliceEdit[]): Plan {
  let next = nextNumber([...plan.slices.map((s) => s.id), ...edits.flatMap((e) => (e.id ? [e.id] : []))])
  const slices = edits.map((e): Slice => ({
    id: e.id ?? `s${next++}`,
    title: e.title,
    scope: e.scope,
    depends_on: [...e.depends_on],
    change: plan.slices.find((s) => s.id === e.id)?.change ?? null,
  }))
  return { status: 'draft', approved_at: null, slices: checked(slices) }
}

// Ruling 8: after approval, slices may be appended, and edited or removed while still planned;
// the order of the existing slices never changes.
function editApproved(plan: Plan, edits: readonly SliceEdit[], statuses: Readonly<Record<string, SliceStatus>>): Plan {
  const planned = (id: string): boolean => (statuses[id] ?? 'planned') === 'planned'
  const firstNew = edits.findIndex((e) => e.id === null)
  if (firstNew !== -1 && edits.slice(firstNew).some((e) => e.id !== null)) {
    throw new HttpError(409, 'order_fixed', 'New slices can only be added after the last slice of an approved plan')
  }
  const kept = edits.filter((e): e is SliceEdit & { id: string } => e.id !== null)
  const positions = kept.map((e) => plan.slices.findIndex((s) => s.id === e.id))
  if (positions.some((p) => p === -1)) throw new HttpError(422, 'invalid_plan', 'an edit names a slice that is not in the plan')
  if (positions.some((p, i) => i > 0 && p <= positions[i - 1]!)) throw new HttpError(409, 'order_fixed', 'The order of an approved plan is fixed')
  for (const s of plan.slices) {
    const edit = kept.find((e) => e.id === s.id)
    if (!edit && !planned(s.id)) throw new HttpError(409, 'slice_not_planned', `${s.id} is ${statuses[s.id]} and cannot be removed`)
    if (edit && !sameContent(edit, s) && !planned(s.id)) throw new HttpError(409, 'slice_not_planned', `${s.id} is ${statuses[s.id]} and cannot be edited`)
  }
  let next = nextNumber(plan.slices.map((s) => s.id))
  const slices = edits.map((e): Slice => {
    const existing = e.id ? plan.slices.find((s) => s.id === e.id)! : null
    return { id: existing?.id ?? `s${next++}`, title: e.title, scope: e.scope, depends_on: [...e.depends_on], change: existing?.change ?? null }
  })
  return { ...plan, slices: checked(slices) }
}

export function editPlan(plan: Plan, edits: readonly SliceEdit[], statuses: Readonly<Record<string, SliceStatus>>): Plan {
  return plan.status === 'approved' ? editApproved(plan, edits, statuses) : editDraft(plan, edits)
}

// Spec B §4.3: approval renumbers the ids in order.
export function approvePlan(plan: Plan, at: string): Plan {
  if (plan.status !== 'draft') throw new HttpError(409, 'plan_not_draft', `The plan is ${plan.status}, not a draft`)
  if (plan.slices.length === 0) throw new HttpError(409, 'empty_plan', 'An empty plan cannot be approved')
  const renamed = new Map(plan.slices.map((s, i) => [s.id, `s${i + 1}`]))
  const slices = plan.slices.map((s): Slice => ({ ...s, id: renamed.get(s.id)!, depends_on: s.depends_on.map((d) => renamed.get(d) ?? d) }))
  return { status: 'approved', approved_at: at, slices: checked(slices) }
}

export function deriveStatus(slice: Slice, facts: SliceFacts): SliceStatus {
  if (!slice.change || !facts.changeExists) return facts.authorRunning ? 'proposing' : 'planned'
  if (facts.applied) return 'applied'
  return facts.approved ? 'approved' : 'proposed'
}

// Spec B §4.4: a planned slice may be proposed once every dependency is approved or applied.
export function proposeBlocker(slices: readonly Slice[], statuses: Readonly<Record<string, SliceStatus>>, id: string): string | null {
  const status = statuses[id] ?? 'planned'
  if (status !== 'planned') return `${id} is ${status}`
  const slice = slices.find((s) => s.id === id)
  const waiting = (slice?.depends_on ?? []).filter((d) => statuses[d] !== 'approved' && statuses[d] !== 'applied')
  return waiting.length ? `waiting for ${waiting.join(', ')}` : null
}
