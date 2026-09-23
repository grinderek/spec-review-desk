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

export function patchPaths(diff: string): string[] {
  const lines = diff.split('\n')
  const paths = new Set<string>()
  lines.forEach((line, i) => {
    if (!line.startsWith('--- ') || !lines[i + 1]?.startsWith('+++ ')) return
    for (const candidate of [headerPath(line.slice(4)), headerPath(lines[i + 1]!.slice(4))]) {
      if (candidate) paths.add(candidate)
    }
  })
  return [...paths]
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
