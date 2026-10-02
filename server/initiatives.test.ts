import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addDecisions, ownerDecision } from './decision-model.ts'
import { discover, listWorktrees, Registry, worktreeId } from './discovery.ts'
import { emptyInitiative, type InitiativeDoc, readInitiative, writeInitiative } from './initiative-store.ts'
import { findInitiative, initiativeTags, listInitiatives, loadInitiativeView, summarizeInitiative } from './initiatives.ts'
import { recordApproval, updateReview, upsertApplyRun } from './review-store.ts'
import { FEATURE } from './testing/fixtures.ts'
import { makeRepo, sh } from './testing/repo.ts'

const AT = '2026-09-24T10:00:00.000Z'

async function setup(over: Partial<InitiativeDoc> = {}) {
  const { hub, repo } = await makeRepo()
  const [wt] = await listWorktrees({ name: 'api', path: repo })
  const dir = path.join(repo, 'openspec/initiatives/hs')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'brief.md'), '# Health score\n')
  const doc: InitiativeDoc = {
    ...emptyInitiative({ name: 'hs', title: 'Health score', repo: 'api', created_at: AT }),
    plan: {
      status: 'approved',
      approved_at: AT,
      slices: [
        { id: 's1', title: 'Threads', scope: 'Thread state.', depends_on: [], change: 'add-thread-state' },
        { id: 's2', title: 'Email', scope: 'Email.', depends_on: ['s1'], change: null },
        { id: 's3', title: 'Calendar', scope: 'Calendar.', depends_on: ['s2'], change: null },
      ],
    },
    runs: [{
      id: 'r_00000001', kind: 'author', slice: 's2', topic: null, session: 's', container: 'sr-r_00000001', log: '.spec-review/runs/r_00000001.ndjson',
      started_at: AT, ended_at: null, outcome: 'running', notes: null, change: 'add-hs-email',
    }],
    ...over,
  }
  await writeInitiative(dir, doc)
  return { hub, repo, wt: wt!, dir }
}

describe('discovery of initiatives', () => {
  it('finds initiatives in a worktree and registers worktrees that have no changes', async () => {
    const { hub, repo, wt } = await setup()
    expect(await listInitiatives(wt)).toEqual([{ worktreeId: wt.id, name: 'hs', dir: path.join(repo, 'openspec/initiatives/hs'), relDir: 'openspec/initiatives/hs' }])
    await expect(findInitiative(wt, 'nope')).rejects.toMatchObject({ code: 'unknown_initiative' })
    const bare = path.join(hub, 'wt-bare')
    sh(repo, 'git', ['worktree', 'add', '-q', bare, '-b', 'plan/bare'])
    sh(bare, 'git', ['rm', '-q', '-r', 'openspec/changes'])
    const registry = new Registry()
    await discover([{ name: 'api', path: repo }], registry)
    expect(registry.get(worktreeId(bare))?.branch).toBe('plan/bare')
  })
})

describe('loadInitiativeView', () => {

  it('keeps a slice proposing while its author waits for the owner (final review I2)', async () => {
    const { wt, dir } = await setup()
    await writeInitiative(dir, { ...(await readInitiative(dir)), runs: (await readInitiative(dir)).runs.map((r) => ({ ...r, outcome: 'needs_owner' as const })) })
    const view = await loadInitiativeView(wt, await findInitiative(wt, 'hs'))
    expect(view.statuses.s2).toBe('proposing')
    expect(view.blockers.s2).toBe('s2 is proposing')
  })

  it('serves the initiative inbox and counts its blocking decisions', async () => {
    const { wt, dir } = await setup({ plan: { status: 'draft', approved_at: null, slices: [] }, runs: [] })
    const decision = ownerDecision({ question: 'Email first?', scope: { kind: 'change' }, blocking: true, options: [] }, AT, () => 'd_00000001')
    await updateReview(dir, (d) => addDecisions(d, [decision]))
    const view = await loadInitiativeView(wt, await findInitiative(wt, 'hs'))
    expect(view.decisions).toEqual([{ ...decision, orphaned: false }])
    expect(view.blockingDecisions).toBe(1)
    expect(summarizeInitiative(view)).toMatchObject({ name: 'hs', title: 'Health score', planStatus: 'draft', applied: 0, total: 0, openDecisions: 1, blockingDecisions: 1, running: 0 })
  })

  it('tags the changes of an initiative with its slice', async () => {
    const { wt } = await setup()
    expect(await initiativeTags(wt)).toEqual({ 'add-thread-state': 'hs · s1' })
  })
})
