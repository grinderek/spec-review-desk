import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './config.ts'
import type { CodexRunSpec } from './codex.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { git } from './git.ts'

export async function applyWorkspace(config: Config, wt: WorktreeInfo) {
  const anchor = await realpath(wt.path)
  const repo = config.repos.find(repo => repo.name === wt.repo || path.resolve(repo.path) === path.resolve(wt.path))
  const products = repo ? (config.products ?? []).filter(product => product.components.some(c => c.repo === repo.name)) : []
  if (products.length > 1) throw new HttpError(409, 'apply_product_ambiguous', 'The implementation repository belongs to several products; configure an unambiguous product scope')
  const product = products[0]
  const profile = config.runners.find(r => r.worktreePath === wt.path || r.worktreePath === repo?.path)
  const requested = [{ name: repo?.name ?? wt.repo ?? 'workspace', path: anchor, git: true },
    ...(product ? product.components.filter(c => c.repo !== repo?.name).map(c => ({ name: c.repo ?? c.name, path: c.path, git: Boolean(c.repo) }))
      : (profile?.sources ?? []).map(c => ({ ...c, git: true })))]
  const roots: NonNullable<CodexRunSpec['workspaceRoots']> = []
  for (const item of requested) {
    try {
      const root = await realpath(item.path)
      if (!(await stat(root)).isDirectory()) throw new Error('Not a directory')
      if (item.git && await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim()) !== root) throw new Error('Not a Git checkout root')
      if (!roots.some(r => r.path === root)) roots.push({ ...item, path: root })
    } catch {
      throw new HttpError(409, 'apply_component_unavailable', `Apply cannot access component ${item.name}: ${item.path}`)
    }
  }
  if (new Set(roots.map(r => r.name)).size !== roots.length) throw new HttpError(409, 'apply_scope_invalid', 'Apply component names must be unique')
  const checks: NonNullable<CodexRunSpec['checks']> = []
  for (const root of roots) {
    const runner = config.runners.find(r => r.worktreePath === root.path || root.path === anchor && r === profile)
    if (!runner) continue
    const command = runner.execution === 'local' ? runner.command : runner.compose ? [
      'docker', 'compose', '-p', runner.compose.project, ...runner.compose.files.flatMap(f => ['-f', f]),
      'exec', '-T', runner.compose.service, ...runner.command,
    ] : null
    if (command) checks.push({ name: `${root.name}:verify`, cwd: root.path, argv: command, timeoutMs: 45 * 60_000 })
    for (const check of runner.applyChecks ?? []) checks.push({ name: `${root.name}:${check.name}`, cwd: root.path, argv: check.command, timeoutMs: check.timeoutMs })
  }
  if (new Set(checks.map(c => c.name)).size !== checks.length) throw new HttpError(409, 'apply_scope_invalid', 'Apply check names must be unique')
  const instructions = new Map<string, string>()
  const contextRoot = path.dirname(path.resolve(config.hubRoot))
  for (const root of roots) {
    for (let dir = root.path; dir === contextRoot || dir.startsWith(contextRoot + path.sep); dir = path.dirname(dir)) {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const file = path.join(dir, name)
        if (instructions.has(file)) continue
        const body = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (body !== null) {
          if (Buffer.byteLength(body) > 128_000) throw new HttpError(409, 'apply_instructions_too_large', `Repository instructions are too large: ${file}`)
          instructions.set(file, body)
        }
      }
      if (dir === contextRoot) break
    }
  }
  const context = [
    `## Apply workspace${product ? `: ${product.title}` : ''}`,
    `The approved change lives in ${anchor}. Implement it across these explicitly configured components.`,
    ...roots.map(r => `- ${r.name}: ${r.path}${r.git ? ' (Git checkout)' : ' (supporting directory; no Git commands)'}`),
    'Use absolute file paths or paths relative to the change repository. desk.run_command accepts repository=<component name>; it defaults to the change repository.',
    'Use desk.run_check with one of the configured names below. It runs the exact configured argv, with a timeout suitable for the environment and verification.',
    ...checks.map(c => `- ${c.name}: ${JSON.stringify(c.argv)} in ${c.cwd}`),
    'Inspect git status and diff in each repository before editing. Preserve pre-existing local changes. Stage explicit implementation paths only; never use git add -A, git add ., or commit unrelated edits.',
    'Do not edit Desk-owned review, initiative or verification journals/projections, and do not modify the approved proposal contracts. Promote the approved contracts to the living corpus and implement their real adapters.',
    'Commit only the implementation changes in each affected Git checkout. Report each repository, commit and actual check result. Do not push or deploy.',
    ...[...instructions].map(([file, body]) => `\n### Repository instructions: ${file}\n${body}`),
  ].join('\n')
  if (Buffer.byteLength(context) > 750_000) throw new HttpError(409, 'apply_instructions_too_large', 'Combined repository instructions exceed the Apply context limit')
  return { roots, checks, context, allowedTools: profile?.applyAllowedTools }
}
