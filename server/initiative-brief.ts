import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import type { RunTarget } from './run-service.ts'

// openspec/initiatives/<name>/brief.md — what, why and out of scope, written by the owner at
// creation and edited on the Brief tab (Desk fixes item 2).
export const BRIEF_FILE = 'brief.md'
export const MAX_BRIEF_CHARS = 20_000

// The file always ends with one newline, as git and the agents expect.
export const briefText = (brief: string): string => (brief.endsWith('\n') ? brief : `${brief}\n`)

// Writes and commits the brief (`docs(openspec): <name> — brief`). An unchanged brief is not
// committed again: `commit` is null.
export async function saveBrief(target: RunTarget, brief: string, trailer: string): Promise<{ brief: string; commit: string | null }> {
  const { wt, ini } = target
  const file = path.join(ini.dir, BRIEF_FILE)
  const text = briefText(brief)
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === text) return { brief: text, commit: null }
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
  const commit = await commitPaths(wt.path, [`${ini.relDir}/${BRIEF_FILE}`], initiativeCommitMessage(`${ini.name} — brief`, trailer))
  return { brief: text, commit }
}
