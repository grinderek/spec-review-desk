import { describe, expect, it } from 'vitest'
import type { Plan } from './initiative-store.ts'
import {
  approvePlan, dependencyIssues, deriveStatus, editPlan, plannerSliceIssues, proposeBlocker, type SliceStatus, slicesFromPlanner,
} from './slice-plan.ts'

const AT = '2026-09-24T10:00:00.000Z'
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}
const slice = (id: string, depends_on: string[] = [], change: string | null = null) => ({ id, title: `Title ${id}`, scope: `Scope ${id}`, depends_on, change })
const draft = (slices = [slice('s1'), slice('s2', ['s1'])]): Plan => ({ status: 'draft', approved_at: null, slices })
const approved = (slices = [slice('s1', [], 'add-x-one'), slice('s2', ['s1']), slice('s3', ['s2'])]): Plan => ({ status: 'approved', approved_at: AT, slices })

describe('planner slices', () => {
  it('accepts 1-based dependency numbers of other slices', () => {
    expect(plannerSliceIssues([{ title: 'A', scope: 'a', depends_on: [] }, { title: 'B', scope: 'b', depends_on: [1] }])).toEqual([])
  })

  it('names out-of-range numbers, self-dependencies and cycles', () => {
    expect(plannerSliceIssues([
      { title: 'A', scope: 'a', depends_on: [3] },
      { title: 'B', scope: 'b', depends_on: [2] },
    ])).toEqual(['slices[0].depends_on: 3 is not a slice number (1..2)', 'slices[1].depends_on: a slice cannot depend on itself'])
    expect(plannerSliceIssues([
      { title: 'A', scope: 'a', depends_on: [2] },
      { title: 'B', scope: 'b', depends_on: [1] },
    ])).toEqual(['slices: dependency cycle s1 → s2 → s1'])
  })

  it('turns planner slices into s1, s2, … with slice-id dependencies', () => {
    expect(slicesFromPlanner([{ title: ' A ', scope: 'a', depends_on: [] }, { title: 'B', scope: 'b', depends_on: [1] }])).toEqual([
      { id: 's1', title: 'A', scope: 'a', depends_on: [], change: null },
      { id: 's2', title: 'B', scope: 'b', depends_on: ['s1'], change: null },
    ])
  })
})

describe('dependencyIssues', () => {
  it('finds unknown ids and cycles', () => {
    expect(dependencyIssues([{ id: 'a', depends_on: ['zz'] }])).toEqual(['a depends on an unknown slice zz'])
    expect(dependencyIssues([{ id: 'a', depends_on: ['c'] }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['b'] }]))
      .toEqual(['dependency cycle a → c → b → a'])
  })
})

describe('editPlan while draft', () => {
  it('replaces the slices in the given order, keeping ids and numbering new ones after the highest', () => {
    const next = editPlan(draft(), [
      { id: 's2', title: 'Two', scope: 'two', depends_on: [] },
      { id: null, title: 'New', scope: 'new', depends_on: ['s2'] },
    ], {})
    expect(next).toEqual({ status: 'draft', approved_at: null, slices: [
      { id: 's2', title: 'Two', scope: 'two', depends_on: [], change: null },
      { id: 's3', title: 'New', scope: 'new', depends_on: ['s2'], change: null },
    ] })
  })

  it('turns no plan into a draft and rejects bad dependencies', () => {
    expect(editPlan({ status: 'none', approved_at: null, slices: [] }, [{ id: null, title: 'A', scope: 'a', depends_on: [] }], {}).status).toBe('draft')
    expect(codeOf(() => editPlan(draft(), [{ id: 's1', title: 'A', scope: 'a', depends_on: ['s1'] }], {}))).toBe('invalid_plan')
    expect(codeOf(() => editPlan(draft(), [{ id: 's1', title: 'A', scope: 'a', depends_on: [] }, { id: 's1', title: 'B', scope: 'b', depends_on: [] }], {})))
      .toBe('invalid_plan')
  })
})

describe('editPlan after approval', () => {
  const statuses: Record<string, SliceStatus> = { s1: 'proposed', s2: 'planned', s3: 'planned' }
  const keep = approved().slices.map(({ change: _c, ...s }) => s)

  it('appends at the end and edits or removes planned slices', () => {
    const next = editPlan(approved(), [keep[0]!, { ...keep[1]!, title: 'Renamed' }, { id: null, title: 'Four', scope: 'four', depends_on: ['s2'] }], statuses)
    expect(next.status).toBe('approved')
    expect(next.approved_at).toBe(AT)
    expect(next.slices.map((s) => [s.id, s.title])).toEqual([['s1', 'Title s1'], ['s2', 'Renamed'], ['s4', 'Four']])
    expect(next.slices[0]!.change).toBe('add-x-one')
  })

  it('refuses to edit or remove a slice that is no longer planned, to reorder, or to insert in the middle', () => {
    expect(codeOf(() => editPlan(approved(), [{ ...keep[0]!, scope: 'changed' }, keep[1]!, keep[2]!], statuses))).toBe('slice_not_planned')
    expect(codeOf(() => editPlan(approved(), [keep[1]!, keep[2]!], statuses))).toBe('slice_not_planned')
    expect(codeOf(() => editPlan(approved(), [keep[0]!, keep[2]!, keep[1]!], statuses))).toBe('order_fixed')
    expect(codeOf(() => editPlan(approved(), [keep[0]!, { id: null, title: 'X', scope: 'x', depends_on: [] }, keep[1]!, keep[2]!], statuses))).toBe('order_fixed')
  })
})

describe('approvePlan', () => {
  it('renumbers in order and maps dependencies', () => {
    const plan = draft([slice('s7'), slice('s2', ['s7'])])
    const next = approvePlan(plan, AT)
    expect(next).toMatchObject({ status: 'approved', approved_at: AT })
    expect(next.slices.map((s) => [s.id, s.title, s.depends_on])).toEqual([['s1', 'Title s7', []], ['s2', 'Title s2', ['s1']]])
  })

  it('needs a non-empty draft', () => {
    expect(codeOf(() => approvePlan(approved(), AT))).toBe('plan_not_draft')
    expect(codeOf(() => approvePlan(draft([]), AT))).toBe('empty_plan')
  })
})

describe('derived status and readiness', () => {
  it('derives the status from the change and the runs', () => {
    const facts = { authorRunning: false, changeExists: false, approved: false, applied: false }
    expect(deriveStatus(slice('s1'), facts)).toBe('planned')
    expect(deriveStatus(slice('s1'), { ...facts, authorRunning: true })).toBe('proposing')
    const withChange = slice('s1', [], 'add-x')
    expect(deriveStatus(withChange, { ...facts, changeExists: true })).toBe('proposed')
    expect(deriveStatus(withChange, { ...facts, changeExists: true, approved: true })).toBe('approved')
    expect(deriveStatus(withChange, { ...facts, changeExists: true, approved: true, applied: true })).toBe('applied')
    expect(deriveStatus(withChange, facts)).toBe('planned')
  })

  it('lets a planned slice be proposed once every dependency is approved or applied', () => {
    const slices = [slice('s1'), slice('s2', ['s1']), slice('s3', ['s1', 's2'])]
    expect(proposeBlocker(slices, { s1: 'planned', s2: 'planned', s3: 'planned' }, 's1')).toBeNull()
    expect(proposeBlocker(slices, { s1: 'proposed', s2: 'planned', s3: 'planned' }, 's2')).toBe('waiting for s1')
    expect(proposeBlocker(slices, { s1: 'applied', s2: 'approved', s3: 'planned' }, 's3')).toBeNull()
    expect(proposeBlocker(slices, { s1: 'applied', s2: 'proposing', s3: 'planned' }, 's3')).toBe('waiting for s2')
    expect(proposeBlocker(slices, { s1: 'proposed', s2: 'planned', s3: 'planned' }, 's1')).toBe('s1 is proposed')
  })
})
