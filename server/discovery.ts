import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { git } from './git.ts'

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

async function isBehaviorDriven(dir: string): Promise<boolean> {
  try {
    const meta = parse(await readFile(path.join(dir, '.openspec.yaml'), 'utf8')) as { schema?: unknown } | null
    return meta?.schema === 'behavior-driven'
  } catch {
    return false
  }
}

async function newestMtime(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true })
  const times = await Promise.all(entries.map(async (e) => (await stat(path.join(dir, e))).mtimeMs))
  return Math.max(0, ...times)
}

async function scan(root: string, wt: WorktreeInfo, archived: boolean): Promise<ChangeRef[]> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'archive').map((d) => d.name)
  } catch {
    return []
  }
  const refs = await Promise.all(
    names.sort().map(async (name): Promise<ChangeRef[]> => {
      const dir = path.join(root, name)
      if (!(await isBehaviorDriven(dir))) return []
      return [{ worktreeId: wt.id, name, dir, archived, mtimeMs: await newestMtime(dir) }]
    }),
  )
  return refs.flat()
}

export async function listChanges(wt: WorktreeInfo): Promise<ChangeRef[]> {
  const root = path.join(wt.path, 'openspec', 'changes')
  return [...(await scan(root, wt, false)), ...(await scan(path.join(root, 'archive'), wt, true))]
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
      return { repo: repo.name, worktrees: worktrees.filter((w) => w.changes.length > 0).sort((a, b) => newest(b) - newest(a)) }
    }),
  )
  registry.set(trees.flatMap((t) => t.worktrees.map(({ changes: _changes, ...wt }) => wt)))
  return trees.filter((t) => t.worktrees.length > 0)
}
