import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from './git.ts'
import { vetPatch } from './questions.ts'
import { makeRepo } from './testing/repo.ts'

const REL = 'openspec/changes/add-thread-state'
const FEATURE = `${REL}/features/thread_state.feature`

async function decisionDiff(repo: string): Promise<string> {
  const file = path.join(repo, FEATURE)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace('  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by age.\n  Scenario Outline:'))
  const diff = await git(repo, ['diff', '--', FEATURE])
  await writeFile(file, original)
  return diff
}

describe('vetPatch', () => {
  it('proposes a normal in-change patch and records its touched files', async () => {
    const { repo } = await makeRepo()
    const patch = await vetPatch(repo, REL, await decisionDiff(repo))
    expect(patch).toMatchObject({ state: 'proposed', error: null })
    expect(patch.files).toEqual([FEATURE])
  })

  it('marks a rename OUTSIDE the change stale even though git numstat only reports the destination', async () => {
    const { repo } = await makeRepo()
    const diff = [
      `diff --git a/${FEATURE} b/app/models/stolen.rb`,
      'similarity index 100%',
      `rename from ${FEATURE}`,
      'rename to app/models/stolen.rb',
      '',
    ].join('\n')
    const patch = await vetPatch(repo, REL, diff)
    expect(patch.state).toBe('stale')
    expect(patch.error).toMatch(/outside|leaves/)
  })

  it('marks a copy OUTSIDE the change stale even though git numstat only reports the destination', async () => {
    const { repo } = await makeRepo()
    const diff = [
      `diff --git a/${FEATURE} b/openspec/changes/old-spec-driven/copied.feature`,
      'similarity index 100%',
      `copy from ${FEATURE}`,
      'copy to openspec/changes/old-spec-driven/copied.feature',
      '',
    ].join('\n')
    const patch = await vetPatch(repo, REL, diff)
    expect(patch.state).toBe('stale')
    expect(patch.error).toMatch(/outside|leaves/)
  })

  it('rejects a binary patch outright', async () => {
    const { repo } = await makeRepo()
    const diff = [
      `diff --git a/${REL}/img.png b/${REL}/img.png`,
      'new file mode 100644',
      'index 0000000..abcdef0',
      'GIT binary patch',
      'literal 7',
      'OcmZQzWMXFc{|^8I9|8mb',
      '',
      'literal 0',
      '',
    ].join('\n')
    const patch = await vetPatch(repo, REL, diff)
    expect(patch.state).toBe('stale')
    expect(patch.error).toMatch(/binary/)
  })

  it('rejects a non-100644 mode change outright', async () => {
    const { repo } = await makeRepo()
    const diff = [`diff --git a/${FEATURE} b/${FEATURE}`, 'old mode 100644', 'new mode 100755', ''].join('\n')
    const patch = await vetPatch(repo, REL, diff)
    expect(patch.state).toBe('stale')
    expect(patch.error).toMatch(/mode/)
  })
})
