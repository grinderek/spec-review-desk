import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Registry, worktreeId } from './discovery.ts'
import { git } from './git.ts'
import { createCommands, type CreateInput, createInitiative } from './initiative-create.ts'
import { readInitiative } from './initiative-store.ts'
import { testConfig } from './testing/http.ts'
import { makeRepo, sh } from './testing/repo.ts'

const AT = '2026-09-24T10:00:00.000Z'
const input = (over: Partial<CreateInput> = {}): CreateInput => ({
  name: 'health-score',
  repo: 'api',
  where: { kind: 'new', base: 'main' },
  title: 'Business health score',
  brief: '# What\n\nScore the day.',
  files: [{ name: 'Spec v1.pdf', bytes: new TextEncoder().encode('%PDF'), source: { kind: 'upload' } }],
  fromRepo: [],
  ...over,
})

describe('createCommands', () => {
  it('previews the worktree command for a new worktree only', () => {
    expect(createCommands(input(), '/hub/api')).toEqual([
      ['git', '-C', '/hub/api', 'worktree', 'add', '.codex/worktrees/health-score', '-b', 'plan/health-score', 'main'],
    ])
    expect(createCommands(input({ where: { kind: 'existing', worktreeId: 'x' } }), '/hub/api')).toEqual([])
  })
})

describe('createInitiative', () => {
  it('creates the worktree and branch, writes the initiative, commits it and registers the worktree', async () => {
    const { repo } = await makeRepo()
    const config = testConfig(repo, { hubRoot: path.dirname(repo) })
    const registry = new Registry()
    const created = await createInitiative(config, registry, input({ fromRepo: ['api/features/STEPS.md'] }), AT)
    const wt = path.join(repo, '.codex/worktrees/health-score')
    expect(created).toEqual({ worktreeId: worktreeId(wt), name: 'health-score' })
    expect(registry.get(created.worktreeId)?.branch).toBe('plan/health-score')
    const dir = path.join(wt, 'openspec/initiatives/health-score')
    const doc = await readInitiative(dir)
    expect(doc).toMatchObject({ name: 'health-score', title: 'Business health score', repo: 'api', created_at: AT, plan: { status: 'none' } })
    expect(doc.inputs.map((i) => [i.file, i.source.kind])).toEqual([['Spec-v1.pdf', 'upload'], ['STEPS.md', 'repo']])
    expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toBe('# What\n\nScore the day.\n')
    expect((await git(wt, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): health-score — initiative')
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
    expect(await readFile(path.join(repo, '.git/info/exclude'), 'utf8')).toContain('.spec-review/')
  })


  it('refuses a bad name, a taken name or branch, an unknown base and a bad input before touching git', async () => {
    const { repo } = await makeRepo()
    const config = testConfig(repo)
    await expect(createInitiative(config, new Registry(), input({ name: 'Bad' }), AT)).rejects.toMatchObject({ code: 'invalid_name' })
    await expect(createInitiative(config, new Registry(), input({ where: { kind: 'new', base: 'nope' } }), AT)).rejects.toMatchObject({ code: 'unknown_base' })
    await expect(createInitiative(config, new Registry(), input({ files: [{ name: 'x.exe', bytes: new Uint8Array(1), source: { kind: 'upload' } }] }), AT))
      .rejects.toMatchObject({ code: 'unsupported_type' })
    await expect(stat(path.join(repo, '.codex/worktrees/health-score'))).rejects.toMatchObject({ code: 'ENOENT' })
    sh(repo, 'git', ['branch', 'plan/health-score'])
    await expect(createInitiative(config, new Registry(), input(), AT)).rejects.toMatchObject({ code: 'name_taken' })
    await expect(createInitiative(config, new Registry(), input({ repo: 'web' }), AT)).rejects.toMatchObject({ code: 'unknown_repo' })
  })

  it('reports a failure after the worktree exists and leaves it for inspection', async () => {
    const { repo } = await makeRepo()
    const config = testConfig(repo)
    sh(repo, 'git', ['config', 'core.hooksPath', path.join(repo, 'hooks')])
    await mkdir(path.join(repo, 'hooks'))
    await writeFile(path.join(repo, 'hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await expect(createInitiative(config, new Registry(), input(), AT)).rejects.toMatchObject({
      code: 'create_failed', message: expect.stringContaining('.codex/worktrees/health-score'),
    })
    expect((await stat(path.join(repo, '.codex/worktrees/health-score/openspec/initiatives/health-score/initiative.yaml'))).isFile()).toBe(true)
  })
})
