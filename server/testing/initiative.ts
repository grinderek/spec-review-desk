import path from 'node:path'
import { listWorktrees, type WorktreeInfo } from '../discovery.ts'
import { emptyInitiative, type InitiativeDoc, writeInitiative } from '../initiative-store.ts'
import { findInitiative, type InitiativeRef } from '../initiatives.ts'
import { sh, writeFiles } from './repo.ts'

export const INITIATIVE_AT = '2026-09-24T10:00:00.000Z'

// A committed initiative "hs" in the test repo, with a brief and one accepted input.
export async function makeInitiative(repo: string, over: Partial<InitiativeDoc> = {}): Promise<{ wt: WorktreeInfo; ini: InitiativeRef; dir: string }> {
  const dir = path.join(repo, 'openspec/initiatives/hs')
  await writeFiles(dir, { 'brief.md': '# Health score\n\nScore the founder day.\n', 'inputs/spec.md': '# Spec\n' })
  await writeInitiative(dir, {
    ...emptyInitiative({ name: 'hs', title: 'Health score', repo: 'api', created_at: INITIATIVE_AT }),
    inputs: [{ file: 'spec.md', bytes: 7, source: { kind: 'upload' }, added_at: INITIATIVE_AT, draft: false }],
    ...over,
  })
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'initiative hs'])
  const wt = (await listWorktrees({ name: 'api', path: repo }))[0]!
  return { wt, ini: await findInitiative(wt, 'hs'), dir }
}
