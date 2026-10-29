import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { CodexRunSpec } from './codex.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { writeExecutionArtifact } from './execution-receipts.ts'
import { ensureExcluded } from './git.ts'
import { withReviewLock } from './review-store.ts'
import { mkdir } from 'node:fs/promises'

type Roots = NonNullable<CodexRunSpec['workspaceRoots']>
export async function withApplyScope<T>(wt: WorktreeInfo, ref: ChangeRef, roots: Roots, fn: () => Promise<T>): Promise<T> {
  const paths = [...new Set([wt.path, ...roots.filter(root => root.git).map(root => root.path)])].sort()
  const lock = (index: number): Promise<T> => index === paths.length
    ? withReviewLock(ref.dir, fn) : withWorktreeAdmission(paths[index]!, () => lock(index + 1))
  return lock(0)
}
export async function admitApplyScope(roots: Roots, runId?: string): Promise<void> {
  for (const root of roots.filter(root => root.git)) {
    await assertWorktreeAdmission(root.path, { operation: 'apply', runId })
  }
}
export async function linkApplyScope(wt: WorktreeInfo, ref: ChangeRef, roots: Roots, runId: string): Promise<void> {
  const link = { anchor: wt.path, reviewDir: ref.dir, runId }
  for (const root of roots.filter(root => root.git)) {
    await ensureExcluded(root.path)
    const dir = path.join(root.path, '.spec-review/apply-links')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${runId}.json`)
    try { await writeExecutionArtifact(file, link) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== JSON.stringify(link)) throw error
    }
  }
}
