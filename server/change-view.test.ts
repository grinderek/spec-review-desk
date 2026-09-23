import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findScenario, loadChangeView, summarize } from './change-view.ts'
import { discover, listChanges, Registry, type WorktreeInfo } from './discovery.ts'
import { headSha } from './git.ts'
import { emptyReview, setEntry, writeReview } from './review-store.ts'
import { makeRepo } from './testing/repo.ts'

async function setup() {
  const { repo } = await makeRepo()
  const registry = new Registry()
  await discover([{ name: 'api', path: repo }], registry)
  const wt = registry.all()[0] as WorktreeInfo
  const ref = (await listChanges(wt)).find((c) => c.name === 'add-thread-state')!
  return { repo, wt, ref }
}

describe('loadChangeView', () => {
  it('renders features, phrases, join key and a not-ready gate for a fresh change', async () => {
    const { repo, wt, ref } = await setup()
    const view = await loadChangeView(wt, ref)
    expect(view.relDir).toBe('openspec/changes/add-thread-state')
    expect(view.features).toHaveLength(1)
    expect(view.features[0]!.scenarios.map((s) => s.effective.status)).toEqual(['pending', 'pending'])
    expect(view.phrases.map((p) => [p.kind, p.usedBy])).toEqual([['extension', 0], ['phrase', 2], ['phrase', 1]])
    expect(view.joinKey.ok).toBe(true)
    expect(view.readiness).toEqual({ ready: false, reasons: ['2 scenarios not approved', '3 phrases not approved'] })
    expect(view.docs.proposal).toContain('Threads wait')
    expect(view.features[0]!.scenarios[0]!.decisions[0]!.commit).toBe(await headSha(repo))
    expect(summarize(view)).toMatchObject({ approved: 0, total: 2, phrasesTotal: 3, openThreads: 0, ready: false })
  })

  it('becomes ready once every scenario and phrase is approved with the current hash', async () => {
    const { wt, ref } = await setup()
    const view = await loadChangeView(wt, ref, { withCommits: false })
    const entry = (hash: string) => ({ status: 'approved' as const, text_hash: hash, approved_commit: 'abc', at: 'now' })
    let doc = emptyReview()
    for (const s of view.features.flatMap((f) => f.scenarios)) doc = setEntry(doc, 'scenarios', s.key, entry(s.hash))
    for (const p of view.phrases) doc = setEntry(doc, 'phrases', p.key, entry(p.hash))
    await writeReview(ref.dir, doc)
    const after = await loadChangeView(wt, ref, { withCommits: false })
    expect(after.readiness.ready).toBe(true)
    expect(after.uncommittedReview).toBe(true)
  })

  it('keeps rendering the other files when one feature does not parse', async () => {
    const { wt, ref } = await setup()
    await writeFile(
      path.join(ref.dir, 'features', 'broken.feature'),
      'Feature: a\n  Scenario: s\n    Given x:\n      | a | b |\n      | 1 |\n',
    )
    const view = await loadChangeView(wt, ref, { withCommits: false })
    expect(view.errors.map((e) => e.file)).toEqual(['features/broken.feature'])
    expect(view.features).toHaveLength(1)
    expect(view.readiness.reasons).toContain('1 file failed to parse')
  })

  it('reports an invalid review.yaml and orphaned entries', async () => {
    const { wt, ref } = await setup()
    await writeReview(ref.dir, setEntry(emptyReview(), 'scenarios', 'features/gone.feature::Gone', { status: 'approved', text_hash: 'x', approved_commit: null, at: 'now' }))
    expect((await loadChangeView(wt, ref, { withCommits: false })).orphans.scenarios).toEqual(['features/gone.feature::Gone'])
    await writeFile(path.join(ref.dir, 'review.yaml'), 'version: 7\n')
    const broken = await loadChangeView(wt, ref, { withCommits: false })
    expect(broken.reviewErrors).not.toBeNull()
    expect(broken.readiness.reasons[0]).toBe('review.yaml is invalid')
  })

  it('finds a scenario by key', async () => {
    const { wt, ref } = await setup()
    const view = await loadChangeView(wt, ref, { withCommits: false })
    expect(findScenario(view, "features/thread_state.feature::The founder's reply resolves a waiting thread")?.kind).toBe('Scenario')
    expect(findScenario(view, 'nope')).toBeUndefined()
  })
})
