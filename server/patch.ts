import path from 'node:path'
import { run } from './git.ts'

const DIFF_BLOCK = /```diff\r?\n([\s\S]*?)```/g

export function extractPatch(text: string): string | null {
  const blocks = [...text.matchAll(DIFF_BLOCK)].map((m) => m[1]!)
  const last = blocks.at(-1)
  if (!last || !last.trim()) return null
  return last.endsWith('\n') ? last : `${last}\n`
}

const headerPath = (raw: string): string | null => {
  const value = raw.split('\t')[0]!.trim()
  if (value === '/dev/null') return null
  return value.replace(/^[ab]\//, '')
}

const DIFF_GIT_LINE = /^diff --git (\S+) (\S+)$/
const RENAME_FROM = /^rename from (.+)$/
const RENAME_TO = /^rename to (.+)$/
const COPY_FROM = /^copy from (.+)$/
const COPY_TO = /^copy to (.+)$/

// Text-based fallback: reads every path a `diff --git` section can name, including a pure
// rename or copy that has no `--- `/`+++ ` hunk headers at all. Deliberately over-inclusive
// (fails closed): an extra spurious candidate just gets validated like any other path and can
// only turn a borderline patch `stale`, never let one slip through.
export function patchPaths(diff: string): string[] {
  const lines = diff.split('\n')
  const paths = new Set<string>()
  const add = (p: string | null | undefined) => {
    const value = p?.trim()
    if (value) paths.add(value)
  }
  lines.forEach((line, i) => {
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      add(headerPath(line.slice(4)))
      add(headerPath(lines[i + 1]!.slice(4)))
      return
    }
    const gitLine = DIFF_GIT_LINE.exec(line)
    if (gitLine) {
      add(headerPath(gitLine[1]!))
      add(headerPath(gitLine[2]!))
      return
    }
    add(RENAME_FROM.exec(line)?.[1])
    add(RENAME_TO.exec(line)?.[1])
    add(COPY_FROM.exec(line)?.[1])
    add(COPY_TO.exec(line)?.[1])
  })
  return [...paths]
}

const BINARY_MARKER = /^(GIT binary patch|Binary files )/m
const MODE_LINE = /^(new file mode|old mode|new mode|deleted file mode) (\d+)$/gm

// Fails closed: a patch with a binary blob or a non-regular-file mode never reaches
// `git apply`, whether or not its paths would otherwise be in bounds.
export function disallowedPatchContent(diff: string): string | null {
  if (BINARY_MARKER.test(diff)) return 'binary patches are not allowed'
  for (const match of diff.matchAll(MODE_LINE)) {
    if (match[2] !== '100644') return `${match[1]} ${match[2]}: only mode 100644 is allowed`
  }
  return null
}

// Git's own `--numstat` is authoritative for ordinary adds/modifies/deletes, but for a pure
// rename or copy (no content change) it reports only the destination path — never the source
// (verified against git 2.55: `git apply --numstat -z -` on a 100%-similarity rename prints a
// single record for the "to" path). Relying on it alone would let a rename FROM a file outside
// the change directory pass containment, because only its "to" path — which can be made to sit
// safely inside the change dir — is ever visible to numstat. The text-based `patchPaths` fallback
// reads the `diff --git a/X b/Y` header (and the unambiguous `rename from|to`/`copy from|to`
// lines) to recover that source path, so the two are always combined into one union.
export async function gitApplyPaths(cwd: string, diff: string): Promise<string[]> {
  const result = await run('git', ['apply', '--numstat', '-z', '--whitespace=nowarn', '-'], { cwd, input: diff, allowFailure: true })
  if (result.code !== 0) return []
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => record.split('\t')[2]?.trim())
    .filter((p): p is string => Boolean(p))
}

export async function touchedPaths(cwd: string, diff: string): Promise<string[]> {
  const fromGit = await gitApplyPaths(cwd, diff)
  return [...new Set([...patchPaths(diff), ...fromGit])]
}

export function validatePatchPaths(paths: readonly string[], relDir: string): string[] {
  if (paths.length === 0) return ['the patch names no files']
  return paths.flatMap((p) => {
    if (path.posix.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return [`${p}: absolute paths are not allowed`]
    const normalized = path.posix.normalize(p)
    if (normalized === '..' || normalized.startsWith('../')) return [`${p}: leaves the worktree`]
    if (!normalized.startsWith(`${relDir}/`)) return [`${p}: outside ${relDir}/`]
    return []
  })
}

export async function checkPatch(cwd: string, diff: string): Promise<string | null> {
  const result = await run('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd, input: diff, allowFailure: true })
  return result.code === 0 ? null : result.stderr.trim() || 'git apply --check failed'
}

export async function applyPatch(cwd: string, diff: string): Promise<void> {
  await run('git', ['apply', '--whitespace=nowarn', '-'], { cwd, input: diff })
}

export async function revertPatch(cwd: string, diff: string): Promise<void> {
  await run('git', ['apply', '-R', '--whitespace=nowarn', '-'], { cwd, input: diff })
}

export function commitMessage(changeName: string, summary: string, trailer: string): string {
  const clean = summary.replace(/\s+/g, ' ').trim()
  return `docs(openspec): ${changeName} — ${clean} (owner decision)\n${trailer ? `\n${trailer}\n` : ''}`
}

export function defaultSummary(agentText: string): string {
  const first = agentText
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!first) return 'owner decision'
  return first.length > 72 ? `${first.slice(0, 71)}…` : first
}
