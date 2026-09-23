import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../server/git.ts'
import { startServer } from '../server/main.ts'
import { FAKE_CLAUDE } from '../server/testing/fake-claude-path.ts'
import { makeRepo } from '../server/testing/repo.ts'

const FEATURE = 'openspec/changes/add-thread-state/features/thread_state.feature'

async function main(): Promise<void> {
  const { hub, repo } = await makeRepo()
  const file = path.join(repo, FEATURE)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace('  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n  Scenario Outline:'))
  const diff = await git(repo, ['diff', '--', FEATURE])
  await writeFile(file, original)

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-e2e-'))
  const answer = path.join(tmp, 'answer.md')
  await writeFile(answer, `Rows weigh by business-hour age, not calendar age.\n\n\`\`\`diff\n${diff}\`\`\`\n`)
  process.env.FAKE_CLAUDE_TEXT_FILE = answer
  process.env.FAKE_CLAUDE_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CLAUDE_MODE = 'answer'

  const config = path.join(hub, 'config.yaml')
  await writeFile(config, [
    'hubRoot: .',
    'repos: [{ name: api, path: api }]',
    'port: 4620',
    `claudeBin: ${FAKE_CLAUDE}`,
    'commitTrailer: "Co-Authored-By: E2E <e2e@example.com>"',
    '',
  ].join('\n'))
  await startServer({ configPath: config, token: 'e2e' })
  console.log(`e2e fixture repo: ${repo}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
