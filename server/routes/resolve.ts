import path from 'node:path'
import type { Context } from 'hono'
import type { AppContext } from '../app.ts'
import { type ChangeRef, discover, listChanges, type WorktreeInfo } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { findInitiative } from '../initiatives.ts'
import type { RunTarget } from '../run-service.ts'

export async function resolveWorktree(ctx: AppContext, id: string): Promise<WorktreeInfo> {
  let wt = ctx.registry.get(id)
  if (!wt) {
    await discover(ctx.config.repos, ctx.registry)
    wt = ctx.registry.get(id)
  }
  if (!wt) throw new HttpError(404, 'unknown_worktree', `Unknown worktree ${id}`)
  return wt
}

// Shared by the initiative routes and the initiative-decision routes (spec B §9): every one of
// them is addressed by the same :wt/:name pair and publishes the same 'initiative' bus event.
export async function resolveInitiativeTarget(ctx: AppContext, c: Context): Promise<RunTarget> {
  const wt = await resolveWorktree(ctx, c.req.param('wt')!)
  return { wt, ini: await findInitiative(wt, c.req.param('name')!) }
}

export function publishInitiativeChanged(ctx: AppContext, t: RunTarget): void {
  ctx.bus.publish('initiative', { worktreeId: t.wt.id, name: t.ini.name })
}

export async function resolveChange(ctx: AppContext, wtId: string, name: string): Promise<{ wt: WorktreeInfo; ref: ChangeRef }> {
  const wt = await resolveWorktree(ctx, wtId)
  const ref = (await listChanges(wt)).find((c) => c.name === name)
  if (!ref) throw new HttpError(404, 'unknown_change', `No behavior-driven change "${name}" in ${wt.path}`)
  return { wt, ref }
}

export function assertWritable(ref: ChangeRef): void {
  if (ref.archived) throw new HttpError(409, 'archived', 'Archived changes are read-only')
}

export const relDirOf = (wt: WorktreeInfo, ref: ChangeRef): string => path.relative(wt.path, ref.dir).split(path.sep).join('/')
