import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandError, commitFiles, ensureExcluded, findCommitIntroducing, git, headSha, isDirty, run, showFile } from './git.ts'
import { makeRepo } from './testing/repo.ts'

const FEATURE_PATH = 'openspec/changes/add-thread-state/features/thread_state.feature'

describe('git helpers', () => {
  it('passes stdin and rejects with stderr on failure', async () => {
    const { repo } = await makeRepo()
    expect((await run('cat', [], { cwd: repo, input: 'hello' })).stdout).toBe('hello')
    await expect(git(repo, ['show', 'nope'])).rejects.toBeInstanceOf(CommandError)
    expect((await run('git', ['show', 'nope'], { cwd: repo, allowFailure: true })).code).not.toBe(0)
  })

  it('commits only the named files and returns the new sha', async () => {
    const { repo } = await makeRepo()
    await writeFile(path.join(repo, 'a.txt'), 'a')
    await writeFile(path.join(repo, 'b.txt'), 'b')
    const sha = await commitFiles(repo, ['a.txt'], 'docs: add a\n\nTrailer: yes')
    expect(sha).toBe(await headSha(repo))
    expect(await git(repo, ['log', '-1', '--format=%B'])).toContain('Trailer: yes')
    expect(await isDirty(repo, 'b.txt')).toBe(true)
    expect(await isDirty(repo, 'a.txt')).toBe(false)
  })

  it('shows a file at a revision and finds the commit that introduced a line', async () => {
    const { repo } = await makeRepo()
    const init = await headSha(repo)
    expect(await showFile(repo, init, FEATURE_PATH)).toContain('Feature: Threads are weighed')
    expect(await showFile(repo, init, 'missing.txt')).toBeNull()
    expect(await findCommitIntroducing(repo, 'Owner decision 2026-09-23: ONE reason', FEATURE_PATH)).toBe(init)
    expect(await findCommitIntroducing(repo, 'never written anywhere', FEATURE_PATH)).toBeNull()
  })

  it('adds .spec-review/ to info/exclude once', async () => {
    const { repo } = await makeRepo()
    await ensureExcluded(repo)
    await ensureExcluded(repo)
    const exclude = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l === '.spec-review/')).toHaveLength(1)
  })
})
