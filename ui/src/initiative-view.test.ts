import { describe, expect, it } from 'vitest'
import type { InitiativeSummary } from '../../server/initiatives.ts'
import { addEdit, createPreview, editsChanged, moveEdit, progressLabel, removeEdit, statusSegments, toEdits, toggleDependency } from './initiative-view.ts'

const plan = {
  status: 'draft' as const,
  approved_at: null,
  slices: [
    { id: 's1', title: 'Engine', scope: 'e', depends_on: [], change: null },
    { id: 's2', title: 'Email', scope: 'm', depends_on: ['s1'], change: null },
  ],
}

describe('slice plan editing', () => {
  it('turns a plan into edits and back, detecting changes', () => {
    const edits = toEdits(plan)
    expect(edits).toEqual([
      { id: 's1', title: 'Engine', scope: 'e', depends_on: [] },
      { id: 's2', title: 'Email', scope: 'm', depends_on: ['s1'] },
    ])
    expect(editsChanged(plan, edits)).toBe(false)
    expect(editsChanged(plan, addEdit(edits))).toBe(true)
  })

  it('moves, removes, adds and toggles dependencies without mutating', () => {
    const edits = toEdits(plan)
    const frozen = JSON.stringify(edits)
    expect(moveEdit(edits, 1, -1).map((e) => e.id)).toEqual(['s2', 's1'])
    expect(moveEdit(edits, 0, -1)).toBe(edits)
    expect(removeEdit(edits, 0)).toEqual([{ id: 's2', title: 'Email', scope: 'm', depends_on: [] }])
    expect(addEdit(edits).at(-1)).toEqual({ id: null, title: '', scope: '', depends_on: [] })
    expect(toggleDependency(edits, 1, 's1')[1]!.depends_on).toEqual([])
    expect(toggleDependency(edits, 0, 's2')[0]!.depends_on).toEqual(['s2'])
    expect(JSON.stringify(edits)).toBe(frozen)
  })
})

describe('summaries', () => {
  const summary = {
    slices: [{ id: 's1', status: 'applied' }, { id: 's2', status: 'proposed' }, { id: 's3', status: 'planned' }, { id: 's4', status: 'planned' }],
    applied: 1,
    total: 4,
  } as unknown as InitiativeSummary

  it('draws one bar segment per status in lifecycle order', () => {
    expect(statusSegments(summary)).toEqual([{ status: 'planned', count: 2 }, { status: 'proposed', count: 1 }, { status: 'applied', count: 1 }])
    expect(progressLabel(summary)).toBe('1/4 applied')
    expect(progressLabel({ ...summary, total: 0 } as InitiativeSummary)).toBe('no slice plan')
  })
})

describe('the New feature preview', () => {
  it('shows the git commands Create runs', () => {
    expect(createPreview({ name: 'health-score', repoPath: '/hub/api', where: 'new', base: 'staging', worktreePath: null })).toEqual([
      'git -C /hub/api worktree add .claude/worktrees/health-score -b plan/health-score staging',
      'write openspec/initiatives/health-score/{initiative.yaml,brief.md,inputs/}',
      'git commit -m "docs(openspec): health-score — initiative"',
    ])
    expect(createPreview({ name: 'health-score', repoPath: '/hub/api', where: 'existing', base: '', worktreePath: '/hub/api/wt' })[0]).toBe(
      'use the existing worktree /hub/api/wt',
    )
    expect(createPreview({ name: '', repoPath: '/hub/api', where: 'new', base: 'staging', worktreePath: null })).toEqual([])
  })
})
