import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Config, ProductConfig } from './config.ts'
import { loadCorpus } from './corpus.ts'
import { listWorktrees, worktreeId } from './discovery.ts'
import { run } from './git.ts'

export interface ProductComponent {
  name: string; title: string; role: string; path: string; repo?: string
  kind: 'repository' | 'directory'
  availability: 'available' | 'unavailable'
  problem: string | null
  source: { head: string; branch: string | null; changedFiles: number; worktrees: number } | null
  rules: { count: number; errors: { file: string; message: string }[] } | null
  runner: { name: string; execution: string } | null
  worktreeId: string | null
}
export interface ProductOverview {
  name: string; title: string; description: string; components: ProductComponent[]
}

// Observations only. A configured command is not a verification result or an approval.
async function componentOverview(config: Config, component: ProductConfig['components'][number]): Promise<ProductComponent> {
  const result: ProductComponent = {
    ...component, kind: component.repo ? 'repository' : 'directory',
    availability: 'unavailable', problem: null, source: null, rules: null, runner: null, worktreeId: null,
  }
  try {
    if (!(await stat(component.path)).isDirectory()) throw new Error('Component path is not a directory')
    if (!component.repo) { result.availability = 'available'; return result }
    const git = async (args: string[]) => (await run('git', args, {
      cwd: component.path, timeoutMs: 15_000, environment: { GIT_OPTIONAL_LOCKS: '0' },
    })).stdout
    // Git may walk to a parent repo. Only the explicitly configured checkout belongs here.
    const root = (await git(['rev-parse', '--show-toplevel'])).trim()
    if (await realpath(root) !== await realpath(component.path)) throw new Error('Component path must be the root of its Git checkout')
    const [head, branch, status, worktrees, corpus] = await Promise.all([
      git(['rev-parse', 'HEAD']), git(['branch', '--show-current']),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      listWorktrees({ name: component.repo, path: component.path }), loadCorpus(component.path),
    ])
    const entries = status.split('\0').filter(Boolean)
    let changedFiles = 0
    for (let i = 0; i < entries.length; i++) {
      changedFiles++
      if (/^[RC]|^.[RC]/.test(entries[i]!)) i++
    }
    result.source = { head: head.trim(), branch: branch.trim() || null, changedFiles, worktrees: worktrees.length }
    result.rules = { count: corpus.features.reduce((n, f) => n + f.scenarios.length, 0), errors: corpus.errors }
    const runner = config.runners.find(r => path.resolve(r.worktreePath) === path.resolve(component.path))
    result.runner = runner ? { name: runner.name, execution: runner.execution ?? 'compose' } : null
    result.worktreeId = worktreeId(component.path)
    result.availability = 'available'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    result.problem = code === 'ENOENT' ? 'Папка компонента не найдена.'
      : error instanceof Error && error.message.startsWith('Component path') ? error.message
      : 'Не удалось прочитать компонент. Проверьте путь, доступ к Git и состояние репозитория.'
  }
  return result
}

export async function readProducts(config: Config): Promise<{ products: ProductOverview[] }> {
  return { products: await Promise.all((config.products ?? []).map(async product => ({
    name: product.name, title: product.title, description: product.description,
    components: await Promise.all(product.components.map(component => componentOverview(config, component))),
  }))) }
}
