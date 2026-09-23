import path from 'node:path'
import type { AppContext } from '../app.ts'
import { type ChangeRef, discover, listChanges, type WorktreeInfo } from '../discovery.ts'
import { HttpError } from '../errors.ts'

export async function resolveChange(ctx: AppContext, wtId: string, name: string): Promise<{ wt: WorktreeInfo; ref: ChangeRef }> {
  let wt = ctx.registry.get(wtId)
  if (!wt) {
    await discover(ctx.config.repos, ctx.registry)
    wt = ctx.registry.get(wtId)
  }
  if (!wt) throw new HttpError(404, 'unknown_worktree', `Unknown worktree ${wtId}`)
  const ref = (await listChanges(wt)).find((c) => c.name === name)
  if (!ref) throw new HttpError(404, 'unknown_change', `No behavior-driven change "${name}" in ${wt.path}`)
  return { wt, ref }
}

export function assertWritable(ref: ChangeRef): void {
  if (ref.archived) throw new HttpError(409, 'archived', 'Archived changes are read-only')
}

export const relDirOf = (wt: WorktreeInfo, ref: ChangeRef): string => path.relative(wt.path, ref.dir).split(path.sep).join('/')
