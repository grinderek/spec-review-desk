import { createHash } from 'node:crypto'
import { readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { git } from './git.ts'
import { CHANGE_ROOT, CHANGE_ARCHIVE_ROOT } from './change-package.ts'
import { CHANGE_NAME } from './initiative-model.ts'
import { nativeScopeDirectories } from './native-path.ts'

export interface WorktreeInfo { id: string; repo: string; path: string; branch: string | null; head: string }
export interface ChangeRef { worktreeId: string; name: string; dir: string; archived: boolean; mtimeMs: number }
export interface RepoTree { repo: string; worktrees: (WorktreeInfo & { changes: ChangeRef[] })[] }

export const worktreeId = (p: string): string => createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 10)

export function parseWorktreeList(porcelain: string): { path: string; head: string; branch: string | null }[] {
  return porcelain
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const fields = new Map(
        block.split('\n').map((line): [string, string] => {
          const space = line.indexOf(' ')
          return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
        }),
      )
      const worktree = fields.get('worktree')
      if (!worktree || fields.has('bare')) return []
      return [{ path: worktree, head: (fields.get('HEAD') ?? '').slice(0, 7), branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null }]
    })
}

export async function listWorktrees(repo: { name: string; path: string }): Promise<WorktreeInfo[]> {
  try {
    const porcelain = await git(repo.path, ['worktree', 'list', '--porcelain'])
    return parseWorktreeList(porcelain).map((w) => ({ ...w, id: worktreeId(w.path), repo: repo.name }))
  } catch {
    return []
  }
}

async function newestMtime(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true })
  const times = await Promise.all(entries.map(async (e) => {
    try { return (await lstat(path.join(dir, e))).mtimeMs }
    catch (error) {
      // Atomic review writes can remove a temporary file after readdir saw it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }))
  return Math.max(0, ...times)
}

async function scan(root: string, wt: WorktreeInfo, archived: boolean): Promise<ChangeRef[]> {
  const names = await nativeScopeDirectories(root, name => name !== 'archive' && CHANGE_NAME.test(name))
  const refs = await Promise.all(
    names.sort().map(async (name): Promise<ChangeRef[]> => {
      const dir = path.join(root, name)
      // A missing or malformed declaration must remain visible and cannot hide a live journal.
      // Detailed metadata and executable-contract validation belongs to loadChangePackage.
      return [{ worktreeId: wt.id, name, dir, archived, mtimeMs: await newestMtime(dir) }]
    }),
  )
  return refs.flat()
}

export async function listChanges(wt: WorktreeInfo): Promise<ChangeRef[]> {
  return [...(await scan(path.join(wt.path, CHANGE_ROOT), wt, false)), ...(await scan(path.join(wt.path, CHANGE_ARCHIVE_ROOT), wt, true))]
}

export class Registry {
  #worktrees = new Map<string, WorktreeInfo>()
  set(list: readonly WorktreeInfo[]): void {
    this.#worktrees = new Map(list.map((w) => [w.id, w]))
  }
  get(id: string): WorktreeInfo | undefined {
    return this.#worktrees.get(id)
  }
  all(): WorktreeInfo[] {
    return [...this.#worktrees.values()]
  }
}

export async function discover(repos: readonly { name: string; path: string }[], registry: Registry): Promise<RepoTree[]> {
  const trees = await Promise.all(
    repos.map(async (repo) => {
      const worktrees = await Promise.all((await listWorktrees(repo)).map(async (wt) => ({ ...wt, changes: await listChanges(wt) })))
      const newest = (w: { changes: ChangeRef[] }) => Math.max(0, ...w.changes.map((c) => c.mtimeMs))
      return { repo: repo.name, all: worktrees, worktrees: worktrees.filter((w) => w.changes.length > 0).sort((a, b) => newest(b) - newest(a)) }
    }),
  )
  // Every worktree is registered, even one without changes: a new initiative lives in its own
  // worktree before its first change exists (spec B §4.1).
  registry.set(trees.flatMap((t) => t.all.map(({ changes: _changes, ...wt }) => wt)))
  return trees.map(({ all: _all, ...t }) => t).filter((t) => t.worktrees.length > 0)
}
