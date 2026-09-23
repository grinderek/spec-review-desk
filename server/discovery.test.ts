import { rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discover, parseWorktreeList, Registry, worktreeId } from './discovery.ts'
import { changeFiles, makeRepo, sh, writeFiles } from './testing/repo.ts'

describe('parseWorktreeList', () => {
  it('reads paths, heads and branches and skips bare entries', () => {
    const porcelain = 'worktree /r\nHEAD 1234567890abcdef\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD abcdef1234567890\ndetached\n\nworktree /bare\nbare\n'
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/r', head: '1234567', branch: 'main' },
      { path: '/r/wt', head: 'abcdef1', branch: null },
    ])
  })
})

describe('discover', () => {
  it('finds behavior-driven changes in every worktree, active and archived', async () => {
    const { hub, repo } = await makeRepo()
    await mkdir(path.join(repo, 'openspec/changes/archive'), { recursive: true })
    await rename(path.join(repo, 'openspec/changes/add-thread-state'), path.join(repo, 'openspec/changes/archive/2026-09-20-add-thread-state'))
    await writeFiles(repo, changeFiles('add-thread-state'))
    const second = path.join(hub, 'wt2')
    sh(repo, 'git', ['worktree', 'add', '-q', second, '-b', 'feature'])
    await writeFiles(second, changeFiles('add-other'))

    const registry = new Registry()
    const [tree] = await discover([{ name: 'api', path: repo }, { name: 'web', path: path.join(hub, 'missing') }], registry)
    expect(tree!.repo).toBe('api')
    const byPath = new Map(tree!.worktrees.map((w) => [w.path, w]))
    expect(byPath.get(repo)!.changes.map((c) => [c.name, c.archived])).toEqual([
      ['add-thread-state', false],
      ['2026-09-20-add-thread-state', true],
    ])
    expect(byPath.get(second)!.changes.map((c) => c.name).sort()).toEqual(['add-other', 'add-thread-state'])
    expect(registry.get(worktreeId(second))!.branch).toBe('feature')
  })
})
