import { loadChangeView } from '../change-view.ts'
import type { ChangeRef, WorktreeInfo } from '../discovery.ts'
import { setEntry, updateReview } from '../review-store.ts'

export async function approveEverything(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
  const view = await loadChangeView(wt, ref, { withCommits: false })
  const entry = (hash: string) => ({ status: 'approved' as const, text_hash: hash, approved_commit: null, at: '2026-09-23T10:00:00.000Z' })
  await updateReview(ref.dir, (doc) => {
    let next = doc
    for (const s of view.features.flatMap((f) => f.scenarios)) next = setEntry(next, 'scenarios', s.key, entry(s.hash))
    for (const p of view.phrases) next = setEntry(next, 'phrases', p.key, entry(p.hash))
    return next
  })
}
