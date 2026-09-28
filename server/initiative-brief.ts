import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDirty } from './git.ts'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import { withInitiativeLock } from './initiative-store.ts'
import type { RunTarget } from './run-service.ts'

// openspec/initiatives/<name>/brief.md — what, why and out of scope, written by the owner at
// creation and edited on the Brief tab (Desk fixes item 2).
export const BRIEF_FILE = 'brief.md'
export const MAX_BRIEF_CHARS = 20_000

// LF line breaks (a multipart form sends a textarea's breaks as CRLF) and one final newline, as
// git and the agents expect.
export function briefText(brief: string): string {
  const text = brief.replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

// The limit applies to the stored text (after briefText), so a saved brief always saves again.
export const briefFits = (brief: string): boolean => briefText(brief).length <= MAX_BRIEF_CHARS

// Writes the brief when its text differs, then commits it whenever brief.md differs from HEAD
// (`docs(openspec): <name> — brief`) — also after an earlier save whose commit failed (review fix
// 1). Nothing to commit: `commit` is null. One save at a time per initiative.
export function saveBrief(target: RunTarget, brief: string, trailer: string): Promise<{ brief: string; commit: string | null }> {
  const { wt, ini } = target
  const file = path.join(ini.dir, BRIEF_FILE)
  const rel = `${ini.relDir}/${BRIEF_FILE}`
  const text = briefText(brief)
  return withInitiativeLock(ini.dir, async () => {
    if ((await readFile(file, 'utf8').catch(() => null)) !== text) {
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, text)
      await rename(tmp, file)
    }
    if (!(await isDirty(wt.path, rel))) return { brief: text, commit: null }
    return { brief: text, commit: await commitPaths(wt.path, [rel], initiativeCommitMessage(`${ini.name} — brief`, trailer)) }
  })
}
