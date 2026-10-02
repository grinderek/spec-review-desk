import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './config.ts'
import { discover, listWorktrees, type Registry, worktreeId } from './discovery.ts'
import { HttpError } from './errors.ts'
import { ensureExcluded, run } from './git.ts'
import { BRIEF_FILE, briefText } from './initiative-brief.ts'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import { emptyInitiative, initiativeDir, isInitiativeName, writeInitiative } from './initiative-store.ts'
import { type IncomingFile, planInputs, readRepoFile, writeInputs } from './inputs.ts'

// Spec B §4.1: New feature — a new worktree + branch plan/<name> (or an existing worktree), the
// initiative files, one commit.
export type Where = { kind: 'new'; base: string } | { kind: 'existing'; worktreeId: string }
export interface CreateInput { name: string; repo: string; where: Where; title: string; brief: string; files: IncomingFile[]; fromRepo: string[] }

export const worktreeRel = (name: string): string => `.codex/worktrees/${name}`

// The argv Create runs on the host (the dialog previews the same commands).
export function createCommands(input: Pick<CreateInput, 'name' | 'where'>, repoPath: string): string[][] {
  if (input.where.kind !== 'new') return []
  return [['git', '-C', repoPath, 'worktree', 'add', worktreeRel(input.name), '-b', `plan/${input.name}`, input.where.base]]
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

async function targetWorktree(config: Config, input: CreateInput): Promise<{ repoPath: string; path: string | null }> {
  const repo = config.repos.find((r) => r.name === input.repo)
  if (!repo) throw new HttpError(404, 'unknown_repo', `No configured repo ${input.repo}`)
  const worktrees = await listWorktrees(repo)
  for (const wt of worktrees) {
    if (await exists(path.join(wt.path, 'openspec', 'initiatives', input.name))) {
      throw new HttpError(409, 'name_taken', `An initiative "${input.name}" already exists in ${wt.path}`)
    }
  }
  if (input.where.kind === 'existing') {
    const id = input.where.worktreeId
    const wt = worktrees.find((w) => w.id === id)
    if (!wt) throw new HttpError(404, 'unknown_worktree', `No worktree ${id} in ${input.repo}`)
    return { repoPath: repo.path, path: wt.path }
  }
  const branch = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/plan/${input.name}`], { cwd: repo.path, allowFailure: true })
  if (branch.code === 0) throw new HttpError(409, 'name_taken', `The branch plan/${input.name} already exists`)
  if (await exists(path.join(repo.path, worktreeRel(input.name)))) throw new HttpError(409, 'name_taken', `${worktreeRel(input.name)} already exists`)
  const base = await run('git', ['rev-parse', '--verify', '--quiet', `${input.where.base}^{commit}`], { cwd: repo.path, allowFailure: true })
  if (base.code !== 0) throw new HttpError(422, 'unknown_base', `No branch or commit ${input.where.base} in ${input.repo}`)
  return { repoPath: repo.path, path: null }
}

export async function createInitiative(config: Config, registry: Registry, input: CreateInput, at: string): Promise<{ worktreeId: string; name: string }> {
  if (!isInitiativeName(input.name)) throw new HttpError(422, 'invalid_name', 'The name is a slug: a-z, 0-9 and -, 2 to 41 characters')
  const target = await targetWorktree(config, input)
  const roots = [config.hubRoot, ...config.repos.map((r) => r.path)]
  const copies = await Promise.all(input.fromRepo.map((p) => readRepoFile(roots, config.hubRoot, p)))
  const planned = planInputs({ inputs: [] }, [...input.files, ...copies])
  let wtPath = target.path
  if (!wtPath) {
    const [argv] = createCommands(input, target.repoPath)
    await run(argv![0]!, argv!.slice(1), { cwd: target.repoPath })
    wtPath = path.join(target.repoPath, worktreeRel(input.name))
  }
  const dir = initiativeDir(wtPath, input.name)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, BRIEF_FILE), briefText(input.brief))
    const inputs = await writeInputs(dir, planned, at)
    await writeInitiative(dir, { ...emptyInitiative({ name: input.name, title: input.title, repo: input.repo, created_at: at }), inputs })
    await ensureExcluded(wtPath)
    await commitPaths(wtPath, [`openspec/initiatives/${input.name}`], initiativeCommitMessage(`${input.name} — initiative`, config.commitTrailer))
  } catch (error) {
    // No automatic removal: the worktree stays for inspection (spec B §4.1/§11).
    throw new HttpError(500, 'create_failed', `Creating ${input.name} failed after the worktree existed (${wtPath}): ${(error as Error).message}`)
  }
  await discover(config.repos, registry)
  return { worktreeId: worktreeId(wtPath), name: input.name }
}
