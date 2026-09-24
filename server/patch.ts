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
  // Defensive: vetPatch rejects any diff containing '\r' outright (disallowedPatchContent), so
  // this parser should never actually see one — but a caller that skips that check (or reuses
  // this function directly) must not have a bare '\r' silently defeat every regex below, since
  // none of them match a trailing '\r' (JS '.' and '$' do not span it).
  const lines = diff.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
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
// Any line that starts one of git's extended-header keywords — the block between `diff --git`
// and the `--- `/`+++ ` hunk headers. Scanned as a coarse net for symlink/submodule modes in a
// header shape none of the strict parsers below happen to cover.
const EXTENDED_HEADER_LINE = /^(diff --git|index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to|similarity|dissimilarity)|copy (from|to))/
const DISALLOWED_MODE_VALUES = ['120000', '160000']
// Every line that NAMES a mode change. Whitespace-tolerant on purpose (git itself never emits
// trailing whitespace here, but a hand-built or mutated patch can) — the value is validated
// separately, after trimming.
const MODE_PREFIX_LINE = /^(old|new|deleted file|new file) mode\b.*$/gm
const STRICT_MODE_LINE = /^(?:old|new|deleted file|new file) mode[ \t]+(\d+)[ \t]*$/
// `index <old>..<new> <mode>` carries the mode as an OPTIONAL third field — present whenever a
// mode is known for the blob (e.g. an ordinary content-only edit still names the unchanged
// 100644), absent when a `new file mode`/`deleted file mode` line already declared it.
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?:[ \t]+(\d+)[ \t]*)?$/gm

// Fails closed: a patch with a binary blob, a carriage return, or a non-regular-file mode never
// reaches `git apply`, whether or not its paths would otherwise be in bounds.
export function disallowedPatchContent(diff: string): string | null {
  // CRLF defeats every regex in patchPaths (JS '.' and unanchored '$' do not span '\r'), which
  // is exactly how a rename/copy FROM outside the change directory could pass containment
  // undetected. Rather than special-case every parser for it, no diff may contain '\r' at all.
  if (diff.includes('\r')) return 'the patch contains a carriage return (\\r) — CRLF line endings are not allowed'
  if (BINARY_MARKER.test(diff)) return 'binary patches are not allowed'

  for (const line of diff.split('\n')) {
    if (!EXTENDED_HEADER_LINE.test(line)) continue
    const badMode = DISALLOWED_MODE_VALUES.find((mode) => line.includes(mode))
    if (badMode) return `${line.trim()}: mode ${badMode} (symlink/submodule) is not allowed`
  }

  for (const match of diff.matchAll(MODE_PREFIX_LINE)) {
    const strict = STRICT_MODE_LINE.exec(match[0])
    if (!strict) return `${match[0].trim()}: unparseable mode line`
    if (strict[1] !== '100644') return `${match[0].trim()}: only mode 100644 is allowed`
  }

  for (const match of diff.matchAll(INDEX_LINE)) {
    if (match[1] && match[1] !== '100644') return `${match[0].trim()}: only mode 100644 is allowed`
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
