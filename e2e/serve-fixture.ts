import { rmSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../server/git.ts'
import { startServer } from '../server/main.ts'
import { FAKE_CODEX, FAKE_OPENSPEC } from '../server/testing/fake-codex-path.ts'
import { FakeSandbox } from '../server/testing/fake-sandbox.ts'
import { FEATURE as FEATURE_TEXT, NEW_STEPS_MD, SPEC_MD } from '../server/testing/fixtures.ts'
import { changeFiles, makeRepo, sh, writeFiles } from '../server/testing/repo.ts'

const FEATURE = 'openspec/changes/add-thread-state/features/thread_state.feature'
const DECISION_FEATURE = 'openspec/changes/add-decision-flow/features/thread_state.feature'
const FIRST = "features/thread_state.feature::The founder's reply resolves a waiting thread"
const ENGINE = 'openspec/changes/add-health-score-engine'

async function diffOf(repo: string, rel: string, before: string, insert: string): Promise<string> {
  const file = path.join(repo, rel)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace(before, `${insert}${before}`))
  const diff = await git(repo, ['diff', '--', rel])
  await writeFile(file, original)
  return diff
}

const reply = (over: Record<string, unknown>) => ({ answer: '', patch: null, decisions: [], resolves: [], status: 'answered', ...over })

// Every fixture temp dir this process creates (makeRepo's `hub`, and the `tmp` below) is removed on
// exit — the suite previously leaked ~17k /tmp/sr-* dirs across runs. By default Playwright SIGKILLs
// the whole webServer process group on teardown, which no listener can catch, so this only fires
// because playwright.config.ts's `webServer.gracefulShutdown` makes it send SIGTERM first — that
// reaches this process (same process group), our SIGTERM handler below calls process.exit(), and the
// 'exit' listener runs its (synchronous) rmSync cleanup before the process actually terminates.
const cleanupDirs: string[] = []
process.on('exit', () => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort: never let cleanup crash the shutdown path
    }
  }
})
// Explicit handlers so the signal reaches process.exit() (and so the 'exit' cleanup above runs) even
// if some dependency (e.g. the HTTP server) has already registered its own SIGINT/SIGTERM listener,
// which would otherwise override Node's default terminate-on-signal disposition.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))

async function main(): Promise<void> {
  const { hub, repo } = await makeRepo()
  cleanupDirs.push(hub)
  await writeFiles(repo, changeFiles('add-decision-flow'))
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'a second change for the decisions flow'])
  // The initiative flow branches its worktree from a base without the review fixtures' changes, so
  // the sidebar never lists add-thread-state twice.
  sh(repo, 'git', ['checkout', '-q', '-b', 'initiative-base'])
  sh(repo, 'git', ['rm', '-q', '-r', 'openspec/changes'])
  sh(repo, 'git', ['commit', '-q', '-m', 'a base for the initiative flow'])
  sh(repo, 'git', ['checkout', '-q', 'main'])
  const ageDiff = await diffOf(repo, FEATURE, '  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n')
  const partialDiff = await diffOf(repo, DECISION_FEATURE, "  Scenario: The founder's reply", '  # Owner decision 2026-09-24: partial days count as business days only.\n')
  const plannerReply = reply({
    answer: 'Two slices: the engine, then delivery.',
    status: 'done',
    slices: [{ title: 'Engine', scope: 'The pure scoring engine.', depends_on: [] }, { title: 'Delivery', scope: 'Delivery states.', depends_on: [1] }],
  })
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
    // The live-streams e2e keeps three research runs running for a few seconds at once.
    {
      match: 'Topic: Slow topic',
      delayMs: 6_000,
      reply: reply({ answer: 'Done slowly.', status: 'done', document: '# Slow topic\n\nFound slowly.\n\n## Sources\n- https://developer.intuit.com/\n' }),
    },
    // The input viewer e2e reads this research draft before accepting it.
    {
      match: 'Topic: AR ageing',
      reply: reply({ answer: 'Found it.', status: 'done', document: '# AR ageing\n\nThe **aged receivables** report answers it.\n\n## Sources\n- https://developer.intuit.com/\n' }),
    },
    // The live-refresh e2e watches its planner run while it runs: that one takes a few seconds.
    { match: 'Initiative: live-refresh', delayMs: 3_000, reply: plannerReply },
    // Spec B: the sandboxed planner and author (FakeSandbox runs the fake Codex against the room).
    { match: 'Propose how to slice', reply: plannerReply },
    { match: 'Slice s1', reply: reply({ answer: 'Wrote the engine slice.', status: 'done', change: 'add-health-score-engine' }) },
  ]
  const writes = [{
    match: 'Slice s1',
    files: {
      [`${ENGINE}/.openspec.yaml`]: 'schema: behavior-driven\n',
      [`${ENGINE}/proposal.md`]: '## Why\n\nThe engine.\n',
      [`${ENGINE}/specs/thread-state/spec.md`]: SPEC_MD,
      [`${ENGINE}/features/thread_state.feature`]: FEATURE_TEXT,
      [`${ENGINE}/features/NEW_STEPS.md`]: NEW_STEPS_MD,
    },
  }]

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-e2e-'))
  cleanupDirs.push(tmp)
  const repliesFile = path.join(tmp, 'replies.json')
  await writeFile(repliesFile, JSON.stringify(replies))
  process.env.FAKE_CODEX_REPLIES_FILE = repliesFile
  const writesFile = path.join(tmp, 'writes.json')
  await writeFile(writesFile, JSON.stringify(writes))
  process.env.FAKE_CODEX_WRITES_FILE = writesFile
  process.env.FAKE_CODEX_SESSIONS = path.join(tmp, 'sessions')
  process.env.FAKE_CODEX_MODE = 'answer'
  // The propose/stop e2e scenario proposes slice s1 twice: the first attempt hangs (so the UI's
  // Stop control is exercised), the second is the real scripted 'Slice s1' reply above.
  process.env.FAKE_CODEX_HANG_MATCH = 'Slice s1'
  process.env.FAKE_CODEX_HANG_COUNT_FILE = path.join(tmp, 'hang-count')

  const config = path.join(hub, 'config.yaml')
  await writeFile(config, [
    'hubRoot: .',
    'repos: [{ name: api, path: api }]',
    'port: 4620',
    `codexBin: ${FAKE_CODEX}`,
    `openspecBin: ${FAKE_OPENSPEC}`,
    'initiativeBase: initiative-base',
    'commitTrailer: "Co-Authored-By: E2E <e2e@example.com>"',
    '',
  ].join('\n'))
  await startServer({ configPath: config, token: 'e2e', sandbox: new FakeSandbox() })
  console.log(`e2e fixture repo: ${repo}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
