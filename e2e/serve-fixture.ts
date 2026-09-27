import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../server/git.ts'
import { startServer } from '../server/main.ts'
import { FAKE_CLAUDE } from '../server/testing/fake-claude-path.ts'
import { changeFiles, makeRepo, sh, writeFiles } from '../server/testing/repo.ts'

const FEATURE = 'openspec/changes/add-thread-state/features/thread_state.feature'
const DECISION_FEATURE = 'openspec/changes/add-decision-flow/features/thread_state.feature'
const FIRST = "features/thread_state.feature::The founder's reply resolves a waiting thread"

async function diffOf(repo: string, rel: string, before: string, insert: string): Promise<string> {
  const file = path.join(repo, rel)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace(before, `${insert}${before}`))
  const diff = await git(repo, ['diff', '--', rel])
  await writeFile(file, original)
  return diff
}

const reply = (over: Record<string, unknown>) => ({ answer: '', patch: null, decisions: [], resolves: [], status: 'answered', ...over })

async function main(): Promise<void> {
  const { hub, repo } = await makeRepo()
  await writeFiles(repo, changeFiles('add-decision-flow'))
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'a second change for the decisions flow'])
  const ageDiff = await diffOf(repo, FEATURE, '  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n')
  const partialDiff = await diffOf(repo, DECISION_FEATURE, "  Scenario: The founder's reply", '  # Owner decision 2026-09-24: partial days count as business days only.\n')
  // First match wins, so the most specific prompt text comes first: a thread replays its history.
  const replies = [
    { match: 'Owner decided', reply: reply({ answer: 'Recorded the decision above the scenario.', patch: partialDiff, resolves: ['$DECISION_ID'] }) },
    {
      match: 'Partial counts?',
      reply: reply({
        answer: 'Two readings are possible; this is your call.',
        decisions: [{
          id: 'partial_days',
          question: 'Do partial days count toward the age?',
          scope: { kind: 'scenario', key: FIRST },
          options: [
            { id: 'count_partial', label: 'Count partial days', consequence: 'A thread from 16:00 is one business day old the next morning.' },
            { id: 'whole_days', label: 'Whole days only', consequence: 'A thread from 16:00 ages from the next midnight.' },
          ],
          recommended: 'count_partial',
          blocking: true,
        }],
      }),
    },
    { match: 'Why business hours?', reply: reply({ answer: 'Rows weigh by business-hour age, not calendar age.', patch: ageDiff }) },
  ]

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-e2e-'))
  const repliesFile = path.join(tmp, 'replies.json')
  await writeFile(repliesFile, JSON.stringify(replies))
  process.env.FAKE_CLAUDE_REPLIES_FILE = repliesFile
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
