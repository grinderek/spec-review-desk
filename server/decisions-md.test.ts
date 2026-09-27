import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addDecisions, decideDecision, findDecision, ownerDecision } from './decision-model.ts'
import {
  appendDecisionEntry, type ChangeDecisionInput, commitChangeDecision, decisionCommitMessage, parseDecisionLog, renderDecisionEntry,
} from './decisions-md.ts'
import { git } from './git.ts'
import { emptyReview, readReview, updateReview } from './review-store.ts'
import { makeRepo, sh } from './testing/repo.ts'

const REL = 'openspec/changes/add-thread-state'
const AT = '2026-09-24T10:00:00.000Z'
const flag = ownerDecision(
  {
    question: 'Ship behind a flag?',
    scope: { kind: 'change' },
    blocking: true,
    options: [
      { id: 'flag', label: 'Behind a flag', consequence: 'Off until the owner flips it.' },
      { id: 'direct', label: 'Directly', consequence: 'Live on deploy.' },
    ],
  },
  AT,
  () => 'd_0000aaaa',
)

describe('decisions.md text', () => {
  it('renders the entry of spec §6', () => {
    const decided = findDecision(decideDecision(addDecisions(emptyReview(), [flag]), flag.id, { option: 'flag', note: 'Staging first.' }, AT), flag.id)
    expect(renderDecisionEntry(decided, '2026-09-24')).toBe([
      '## 2026-09-24 — Ship behind a flag?',
      'Decision: Behind a flag — Off until the owner flips it.',
      'Note: Staging first.',
      'Source: owner · d_0000aaaa',
      '',
    ].join('\n'))
  })

  it('starts the file with a one-line header and separates entries by a blank line', () => {
    const first = appendDecisionEntry(null, 'add-thread-state', '## a\n')
    expect(first).toBe('# Owner decisions — add-thread-state\n\n## a\n')
    expect(appendDecisionEntry(first, 'add-thread-state', '## b\n')).toBe('# Owner decisions — add-thread-state\n\n## a\n\n## b\n')
  })

  it('parses entries back, dashes as empty', () => {
    const text = [
      '# Owner decisions — c', '',
      '## 2026-09-24 — Q one?', 'Decision: A — a.', 'Note: —', 'Source: owner · d_0000aaaa', '',
      '## 2026-09-25 — Q two?', 'Decision: —', 'Note: Just do it.', 'Source: thread t_1 · d_0000bbbb', '',
    ].join('\n')
    expect(parseDecisionLog(text)).toEqual([
      { date: '2026-09-24', question: 'Q one?', decision: 'A — a.', note: '', source: 'owner · d_0000aaaa', id: 'd_0000aaaa' },
      { date: '2026-09-25', question: 'Q two?', decision: '', note: 'Just do it.', source: 'thread t_1 · d_0000bbbb', id: 'd_0000bbbb' },
    ])
  })

  it('caps the question at 60 characters in the commit subject', () => {
    const long = 'Should the inbox pillar weigh a thread by business-hour age or by calendar age?'
    const message = decisionCommitMessage('c', long, 'Co-Authored-By: T <t@example.com>')
    expect(message.split('\n')[0]).toBe(`docs(openspec): c — ${long.slice(0, 59)}… (owner decision)`)
    expect(message.endsWith('\n\nCo-Authored-By: T <t@example.com>\n')).toBe(true)
  })
})

async function setup() {
  const { repo } = await makeRepo()
  const dir = path.join(repo, REL)
  await updateReview(dir, (d) => addDecisions(d, [flag]))
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'seed a decision'])
  const input = (over: Partial<ChangeDecisionInput> = {}): ChangeDecisionInput => ({
    cwd: repo,
    relDir: REL,
    changeDir: dir,
    changeName: 'add-thread-state',
    decisionId: flag.id,
    choice: { option: 'flag', note: 'Staging first.' },
    trailer: 'Co-Authored-By: Test <test@example.com>',
    now: new Date(AT),
    ...over,
  })
  return { repo, dir, input }
}

describe('commitChangeDecision', () => {
  it('appends to decisions.md, commits it with review.yaml and writes the sha back', async () => {
    const { repo, dir, input } = await setup()
    const { commit } = await commitChangeDecision(input())
    expect(commit).toBe((await git(repo, ['rev-parse', '--short', 'HEAD'])).trim())
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('docs(openspec): add-thread-state — Ship behind a flag? (owner decision)')
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n').sort()).toEqual([`${REL}/decisions.md`, `${REL}/review.yaml`])
    expect(await readFile(path.join(dir, 'decisions.md'), 'utf8')).toContain('## 2026-09-24 — Ship behind a flag?\nDecision: Behind a flag')
    expect(findDecision(await readReview(dir), flag.id)).toMatchObject({ status: 'recorded', recorded: { how: 'decisions_md', commit } })
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe(`M ${REL}/review.yaml`)
  })

  it('restores both files and leaves the decision open when the commit fails', async () => {
    const { repo, dir, input } = await setup()
    const before = await readFile(path.join(dir, 'review.yaml'), 'utf8')
    await writeFile(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await expect(commitChangeDecision(input())).rejects.toThrow(/git commit/)
    expect(await readFile(path.join(dir, 'review.yaml'), 'utf8')).toBe(before)
    await expect(readFile(path.join(dir, 'decisions.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('')
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('')
    expect(findDecision(await readReview(dir), flag.id).status).toBe('open')
  })

  it('writes nothing for an invalid choice', async () => {
    const { repo, input } = await setup()
    await expect(commitChangeDecision(input({ choice: { option: 'sometimes', note: '' } }))).rejects.toMatchObject({ code: 'unknown_option' })
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('')
  })
})
