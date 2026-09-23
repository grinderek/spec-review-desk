import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from './git.ts'
import { applyPatch, checkPatch, commitMessage, defaultSummary, extractPatch, patchPaths, revertPatch, validatePatchPaths } from './patch.ts'
import { makeRepo } from './testing/repo.ts'

const REL = 'openspec/changes/add-thread-state'
const FEATURE = `${REL}/features/thread_state.feature`

async function diffOf(repo: string, transform: (s: string) => string): Promise<string> {
  const file = path.join(repo, FEATURE)
  const original = await readFile(file, 'utf8')
  await writeFile(file, transform(original))
  const diff = await git(repo, ['diff', '--', FEATURE])
  await writeFile(file, original)
  return diff
}

describe('extractPatch', () => {
  it('takes the last diff block and ends it with a newline', () => {
    const text = 'One:\n```diff\nfirst\n```\nTwo:\n```diff\n--- a/x\n+++ b/x\n```\nDone.'
    expect(extractPatch(text)).toBe('--- a/x\n+++ b/x\n')
    expect(extractPatch('no patch here')).toBeNull()
    expect(extractPatch('```ts\nconst x = 1\n```')).toBeNull()
  })
})

describe('patchPaths and validatePatchPaths', () => {
  it('reads header paths only, including new and deleted files', () => {
    const diff = [
      `diff --git a/${REL}/a.md b/${REL}/a.md`, 'new file mode 100644', '--- /dev/null', `+++ b/${REL}/a.md`, '@@ -0,0 +1 @@', '+--- not a header',
      `diff --git a/${REL}/b.md b/${REL}/b.md`, `--- a/${REL}/b.md`, '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
    ].join('\n')
    expect(patchPaths(diff).sort()).toEqual([`${REL}/a.md`, `${REL}/b.md`])
  })

  it('refuses absolute paths, traversal and files outside the change', () => {
    expect(validatePatchPaths([`${REL}/features/x.feature`], REL)).toEqual([])
    expect(validatePatchPaths(['/etc/passwd'], REL)[0]).toMatch(/absolute/)
    expect(validatePatchPaths([`${REL}/../../../app/models/user.rb`], REL)[0]).toMatch(/leaves|outside/)
    expect(validatePatchPaths(['app/models/user.rb'], REL)[0]).toMatch(/outside/)
    expect(validatePatchPaths([], REL)).toEqual(['the patch names no files'])
  })
})

describe('git apply', () => {
  it('checks, applies and reverts a patch produced by git diff', async () => {
    const { repo } = await makeRepo()
    const diff = await diffOf(repo, (s) => s.replace('  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by age.\n  Scenario Outline:'))
    expect(await checkPatch(repo, diff)).toBeNull()
    await applyPatch(repo, diff)
    expect(await readFile(path.join(repo, FEATURE), 'utf8')).toContain('rows weigh by age')
    expect(await checkPatch(repo, diff)).toMatch(/patch does not apply|already exists/)
    await revertPatch(repo, diff)
    expect(await readFile(path.join(repo, FEATURE), 'utf8')).not.toContain('rows weigh by age')
  })
})

describe('commit messages', () => {
  it('formats the owner-decision message with the trailer', () => {
    expect(commitMessage('add-thread-state', '  needs_reply  survives a reply ', 'Co-Authored-By: X <x@y>'))
      .toBe('docs(openspec): add-thread-state — needs_reply survives a reply (owner decision)\n\nCo-Authored-By: X <x@y>\n')
    expect(commitMessage('c', 's', '')).toBe('docs(openspec): c — s (owner decision)\n')
  })

  it('takes the first prose line of the answer, trimmed to 72 characters', () => {
    expect(defaultSummary('\n```diff\nx\n```\n\nThe reply resolves the thread.\nMore.')).toBe('The reply resolves the thread.')
    expect(defaultSummary('x'.repeat(100))).toHaveLength(72)
    expect(defaultSummary('')).toBe('owner decision')
  })
})
