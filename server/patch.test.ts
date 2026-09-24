import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from './git.ts'
import {
  applyPatch, checkPatch, commitMessage, defaultSummary, disallowedPatchContent, extractPatch, gitApplyPaths, patchPaths, revertPatch,
  touchedPaths, validatePatchPaths,
} from './patch.ts'
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

  it('reads both sides of a pure rename or copy from the diff --git and rename/copy headers', () => {
    const rename = [
      `diff --git a/${REL}/a.feature b/app/models/stolen.rb`,
      'similarity index 100%',
      `rename from ${REL}/a.feature`,
      'rename to app/models/stolen.rb',
      '',
    ].join('\n')
    expect(patchPaths(rename).sort()).toEqual(['app/models/stolen.rb', `${REL}/a.feature`])
    const copy = [
      `diff --git a/${REL}/a.feature b/other/copied.feature`,
      'similarity index 100%',
      `copy from ${REL}/a.feature`,
      'copy to other/copied.feature',
      '',
    ].join('\n')
    expect(patchPaths(copy).sort()).toEqual([`${REL}/a.feature`, 'other/copied.feature'])
  })
})

describe('disallowedPatchContent', () => {
  it('rejects a binary patch and a non-100644 mode, but allows a plain 100644 new file', () => {
    expect(disallowedPatchContent('diff --git a/x b/x\nGIT binary patch\nliteral 0\n')).toMatch(/binary/)
    expect(disallowedPatchContent('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toMatch(/binary/)
    expect(disallowedPatchContent('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toMatch(/mode/)
    expect(disallowedPatchContent(`diff --git a/${REL}/a b/${REL}/a\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/${REL}/a\n@@ -0,0 +1 @@\n+x\n`)).toBeNull()
  })

  it('rejects any carriage return anywhere in the diff, not just in headers', () => {
    expect(disallowedPatchContent('diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')).toMatch(/carriage return|CRLF/)
    // A single stray \r in an otherwise ordinary LF body line still counts.
    expect(disallowedPatchContent('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\r\n')).toMatch(/carriage return|CRLF/)
    expect(disallowedPatchContent('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull()
  })

  it('rejects mode lines with trailing whitespace for any non-100644 value, including symlink and submodule modes', () => {
    expect(disallowedPatchContent('diff --git a/x b/x\nold mode 100644 \nnew mode 100755\t\n')).toMatch(/100755/)
    expect(disallowedPatchContent('diff --git a/x b/x\nnew file mode 120000 \n')).toMatch(/120000/)
    expect(disallowedPatchContent('diff --git a/x b/x\nnew file mode 160000\t\n')).toMatch(/160000/)
    // Trailing whitespace on an otherwise-fine 100644 line is still accepted.
    expect(disallowedPatchContent(`diff --git a/${REL}/a b/${REL}/a\nnew file mode 100644 \nindex 0000000..1\n--- /dev/null\n+++ b/${REL}/a\n@@ -0,0 +1 @@\n+x\n`)).toBeNull()
  })

  it('rejects a non-100644 mode carried on the index line, even with no new/old mode line at all', () => {
    expect(disallowedPatchContent('diff --git a/x b/x\nindex abc..def 120000\n--- a/x\n+++ b/x\n')).toMatch(/120000/)
    expect(disallowedPatchContent('diff --git a/x b/x\nindex abc..def 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull()
  })

  it('fails closed on an unparseable mode-ish line instead of silently ignoring it', () => {
    expect(disallowedPatchContent('diff --git a/x b/x\nold mode garbage\n')).toMatch(/unparseable/)
    expect(disallowedPatchContent('diff --git a/x b/x\nnew mode \n')).toMatch(/unparseable/)
  })
})

describe('gitApplyPaths and touchedPaths', () => {
  it("only reports a pure rename's destination — numstat cannot see the source", async () => {
    const { repo } = await makeRepo()
    const diff = [
      `diff --git a/${REL}/features/thread_state.feature b/app/models/stolen.rb`,
      'similarity index 100%',
      `rename from ${REL}/features/thread_state.feature`,
      'rename to app/models/stolen.rb',
      '',
    ].join('\n')
    expect(await gitApplyPaths(repo, diff)).toEqual(['app/models/stolen.rb'])
    expect((await touchedPaths(repo, diff)).sort()).toEqual(['app/models/stolen.rb', `${REL}/features/thread_state.feature`])
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

  it('accepts a hand-written diff whose hunk header line counts are wrong', async () => {
    const { repo } = await makeRepo()
    const diff = await diffOf(repo, (s) => s.replace('  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by age.\n  Scenario Outline:'))
    const miscounted = diff.replace(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m, (_m, a, b, c, d) => `@@ -${a},${Number(b) + 1} +${c},${Number(d) + 3} @@`)
    expect(miscounted).not.toBe(diff)
    expect(await checkPatch(repo, miscounted)).toBeNull()
    await applyPatch(repo, miscounted)
    expect(await readFile(path.join(repo, FEATURE), 'utf8')).toContain('rows weigh by age')
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
