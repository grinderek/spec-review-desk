import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FEATURE, NEW_STEPS_MD, SPEC_MD, STEPS_MD } from './fixtures.ts'

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body)
  }
}

export function changeFiles(name: string, schema = 'behavior-driven'): Record<string, string> {
  const base = `openspec/changes/${name}`
  return {
    [`${base}/.openspec.yaml`]: `schema: ${schema}\ncreated: 2026-09-22\n`,
    [`${base}/proposal.md`]: '## Why\n\nThreads wait on the founder.\n',
    [`${base}/design.md`]: '## Open Questions\n\n- none\n',
    [`${base}/tasks.md`]: "- [ ] 1.1 The founder's reply resolves a waiting thread\n",
    [`${base}/specs/thread-state/spec.md`]: SPEC_MD,
    [`${base}/features/thread_state.feature`]: FEATURE,
    [`${base}/features/NEW_STEPS.md`]: NEW_STEPS_MD,
  }
}

export async function makeRepo(): Promise<{ hub: string; repo: string }> {
  const hub = await mkdtemp(path.join(os.tmpdir(), 'sr-hub-'))
  const repo = path.join(hub, 'api')
  await mkdir(repo)
  sh(repo, 'git', ['init', '-q', '-b', 'main'])
  sh(repo, 'git', ['config', 'user.email', 'test@example.com'])
  sh(repo, 'git', ['config', 'user.name', 'Test'])
  await writeFiles(repo, {
    'features/STEPS.md': STEPS_MD,
    ...changeFiles('add-thread-state'),
    ...changeFiles('old-spec-driven', 'spec-driven'),
  })
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'init'])
  return { hub, repo }
}
