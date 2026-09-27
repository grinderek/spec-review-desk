import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from './git.ts'
import { readInitiative, updateInitiative } from './initiative-store.ts'
import {
  acceptDraft, discardDraft, type IncomingFile, MAX_INPUT_BYTES, planInputs, readRepoFile, sanitizeInputName, setDomains, uniqueInputName, uploadInputs,
} from './inputs.ts'
import { INITIATIVE_AT, makeInitiative } from './testing/initiative.ts'
import { makeRepo } from './testing/repo.ts'

const TRAILER = 'Co-Authored-By: Test <test@example.com>'
const file = (name: string, text = 'x'): IncomingFile => ({ name, bytes: new TextEncoder().encode(text), source: { kind: 'upload' } })
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

describe('input names', () => {
  it('sanitizes to [A-Za-z0-9._-] without a leading dot, keeping an allowed extension', () => {
    expect(sanitizeInputName('../../etc/Client Spec (v2).PDF')).toBe('Client-Spec-v2-.pdf')
    expect(sanitizeInputName('.env.md')).toBe('env.md')
    expect(sanitizeInputName('Отчёт.md')).toBe('input.md')
    expect(codeOf(() => sanitizeInputName('run.sh'))).toBe('unsupported_type')
    expect(uniqueInputName(['a.md', 'a-2.md'], 'a.md')).toBe('a-3.md')
  })

  it('limits one file to 20 MB and an initiative to 100 MB', () => {
    const big = { name: 'big.pdf', bytes: new Uint8Array(MAX_INPUT_BYTES + 1), source: { kind: 'upload' as const } }
    expect(codeOf(() => planInputs({ inputs: [] }, [big]))).toBe('input_too_large')
    const existing = [{ file: 'old.pdf', bytes: 95 * 1024 * 1024, source: { kind: 'upload' as const }, added_at: 'x', draft: false }]
    expect(codeOf(() => planInputs({ inputs: existing }, [{ ...big, bytes: new Uint8Array(6 * 1024 * 1024) }]))).toBe('inputs_too_large')
    expect(planInputs({ inputs: existing }, [file('old.pdf'), file('old.pdf')]).map((p) => p.name)).toEqual(['old-2.pdf', 'old-3.pdf'])
  })
})

describe('uploads and repo copies', () => {
  it('writes uploads into inputs/, records provenance and commits', async () => {
    const { repo } = await makeRepo()
    const { wt, ini, dir } = await makeInitiative(repo)
    expect(await uploadInputs({ wt, ini }, [file('spec.md', '# New'), file('notes.txt', 'n')], TRAILER, INITIATIVE_AT)).toEqual(['spec-2.md', 'notes.txt'])
    expect(await readFile(path.join(dir, 'inputs/spec-2.md'), 'utf8')).toBe('# New')
    expect((await readInitiative(dir)).inputs.map((i) => [i.file, i.bytes])).toEqual([['spec.md', 7], ['spec-2.md', 5], ['notes.txt', 1]])
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): hs — inputs: spec-2.md, notes.txt')
  })

  it('copies a regular file from inside the hub with its path and HEAD, and refuses anything else', async () => {
    const { hub, repo } = await makeRepo()
    await mkdir(path.join(repo, 'doc'))
    await writeFile(path.join(repo, 'doc/contract.md'), '# Contract\n')
    await symlink('/etc/hostname', path.join(repo, 'doc/link.md'))
    const head = (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim()
    const copy = await readRepoFile([hub, repo], hub, 'api/doc/contract.md')
    expect(copy).toMatchObject({ name: 'contract.md', source: { kind: 'repo', path: 'api/doc/contract.md', commit: head } })
    await expect(readRepoFile([hub, repo], hub, 'api/doc/link.md')).rejects.toMatchObject({ code: 'outside_repos' })
    await expect(readRepoFile([hub, repo], hub, '../outside.md')).rejects.toMatchObject({ code: 'unknown_file' })
    await expect(readRepoFile([hub, repo], hub, 'api/doc')).rejects.toMatchObject({ code: 'not_a_file' })
    await expect(readRepoFile([hub, repo], hub, 'api/features/STEPS.md')).resolves.toMatchObject({ name: 'STEPS.md' })
  })
})

describe('research drafts and domains', () => {
  async function withDraft() {
    const { repo } = await makeRepo()
    const { wt, ini, dir } = await makeInitiative(repo)
    await writeFile(path.join(dir, 'inputs/research-intuit.md'), '# Intuit\n')
    await updateInitiative(dir, (d) => ({
      ...d,
      inputs: [...d.inputs, { file: 'research-intuit.md', bytes: 9, source: { kind: 'research', run: 'r_00000001', domains: [] }, added_at: INITIATIVE_AT, draft: true }],
      runs: [{ id: 'r_00000001', kind: 'research', slice: null, topic: 'Intuit reports', session: 's', container: 'sr-r_00000001', log: '.spec-review/runs/r_00000001.ndjson', started_at: INITIATIVE_AT, ended_at: INITIATIVE_AT, outcome: 'done', notes: null }],
    }))
    return { repo, target: { wt, ini }, dir }
  }

  it('accepts a draft with a commit named after the topic', async () => {
    const { repo, target, dir } = await withDraft()
    await acceptDraft(target, 'research-intuit.md', TRAILER)
    expect((await readInitiative(dir)).inputs.at(-1)!.draft).toBe(false)
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): hs — research: Intuit reports')
    await expect(acceptDraft(target, 'research-intuit.md', TRAILER)).rejects.toMatchObject({ code: 'not_a_draft' })
  })

  it('discards a draft without a commit', async () => {
    const { repo, target, dir } = await withDraft()
    const before = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await discardDraft(target, 'research-intuit.md')
    await expect(stat(path.join(dir, 'inputs/research-intuit.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readInitiative(dir)).inputs.map((i) => i.file)).toEqual(['spec.md'])
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(before)
    await expect(discardDraft(target, 'spec.md')).rejects.toMatchObject({ code: 'not_a_draft' })
  })

  it('edits the domain allowlist with a commit, refusing anything but hostnames', async () => {
    const { repo, target, dir } = await withDraft()
    expect(await setDomains(target, ['Docs.Stripe.com', 'docs.stripe.com', 'developer.intuit.com'], TRAILER)).toEqual(['docs.stripe.com', 'developer.intuit.com'])
    expect((await readInitiative(dir)).research.domains).toEqual(['docs.stripe.com', 'developer.intuit.com'])
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): hs — research domains')
    await expect(setDomains(target, ['https://x.com'], TRAILER)).rejects.toMatchObject({ code: 'invalid_domain' })
  })
})
