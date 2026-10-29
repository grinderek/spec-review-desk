import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../server/git.ts'
import { requireAttemptInactive, stopLocalAttempt } from '../server/execution-receipts.ts'
import { startServer } from '../server/main.ts'
import { FAKE_CODEX } from '../server/testing/fake-codex-path.ts'
import { FakeSandbox } from '../server/testing/fake-sandbox.ts'
import { FEATURE as FEATURE_TEXT, NEW_STEPS_MD } from '../server/testing/fixtures.ts'
import { changeFiles, makeRepo, sh, writeFiles } from '../server/testing/repo.ts'

const FEATURE = 'desk/changes/add-thread-state/features/thread_state.feature'
const DECISION_FEATURE = 'desk/changes/add-decision-flow/features/thread_state.feature'
const FIRST = "thread_state.feature::founder-reply-resolves"
const ENGINE = 'desk/changes/add-health-score-engine'

async function diffOf(repo: string, rel: string, before: string, insert: string): Promise<string> {
  const file = path.join(repo, rel)
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace(before, `${insert}${before}`))
  const diff = await git(repo, ['diff', '--', rel])
  await writeFile(file, original)
  return diff
}

const reply = (over: Record<string, unknown>) => ({ answer: '', patch: null, decisions: [], resolves: [], status: 'answered', ...over })

// Detached workers deliberately survive a production server exit. The fixture owns its temporary
// repositories, so it must prove those workers stopped before deleting their durable artifacts.
const cleanupDirs: string[] = []
let closeFixture: (() => Promise<void>) | undefined
async function fixtureAttempts(dir: string): Promise<{ cwd: string; id: string }[]> {
  const attempts: { cwd: string; id: string }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue
    const child = path.join(dir, entry.name)
    if (entry.name === 'executions' && path.basename(dir) === '.spec-review') {
      for (const attempt of await readdir(child, { withFileTypes: true })) {
        if (attempt.isDirectory() && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attempt.name)) {
          attempts.push({ cwd: path.dirname(dir), id: attempt.name })
        }
      }
    } else {
      attempts.push(...await fixtureAttempts(child))
    }
  }
  return attempts
}
let shutdown: Promise<void> | undefined
function teardown(code: number): Promise<void> {
  return shutdown ??= (async () => {
    const deadline = Date.now() + 4_000
    const timeout = setTimeout(() => {
      console.error('Fixture cleanup timed out; retaining temporary artifacts')
      process.exit(code)
    }, 4_000)
    try {
      await closeFixture?.()
      const attempts = (await Promise.all(cleanupDirs.map(fixtureAttempts))).flat()
      await Promise.all(attempts.map(({ cwd, id }) => stopLocalAttempt(cwd, id)))
      for (;;) {
        const observations = await Promise.allSettled(attempts.map(({ cwd, id }) => requireAttemptInactive(cwd, id)))
        if (observations.every(result => result.status === 'fulfilled')) break
        if (Date.now() >= deadline) throw new Error('Fixture workers did not prove inactivity; retaining their temporary artifacts')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await Promise.all(cleanupDirs.map(dir => rm(dir, { recursive: true, force: true })))
    } catch (error) {
      console.error('Fixture cleanup retained temporary artifacts:', error)
    }
    clearTimeout(timeout)
    process.exit(code)
  })()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void teardown(0) })

async function main(): Promise<void> {
  const { hub, repo } = await makeRepo()
  cleanupDirs.push(hub)
  await writeFiles(repo, changeFiles('add-decision-flow'))
  await writeFiles(repo, {
    'desk/changes/add-dsl-review/change.yaml': 'version: 1\nkind: behavior-driven\n',
    'desk/changes/add-dsl-review/features/review.desk.yaml': `version: 1
feature: DSL browser review
scenarios:
  - id: review-yaml
    scenario: Review a YAML contract
    given:
      - ScenarioDiscovered: {}
    when:
      ApproveScenario: { key: subject }
    then:
      events:
        - ScenarioApproved: { key: subject }
      response: { status: 200 }
`,
  })
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'a second change for the decisions flow'])
  // The initiative flow branches its worktree from a base without the review fixtures' changes, so
  // the sidebar never lists add-thread-state twice.
  sh(repo, 'git', ['checkout', '-q', '-b', 'initiative-base'])
  sh(repo, 'git', ['rm', '-q', '-r', 'desk/changes'])
  sh(repo, 'git', ['commit', '-q', '-m', 'a base for the initiative flow'])
  sh(repo, 'git', ['checkout', '-q', 'main'])
  const ageDiff = await diffOf(repo, FEATURE, '  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n')
  // Another accepted edit changes the patch context before the question is answered.
  // Regenerating must use this current file rather than retrying the earlier diff.
  const ageFile = path.join(repo, FEATURE)
  await writeFile(ageFile, (await readFile(ageFile, 'utf8')).replace('  Scenario Outline:', '  Scenario Outline: '))
  sh(repo, 'git', ['add', '--', FEATURE])
  sh(repo, 'git', ['commit', '-q', '-m', 'Independent formatting revision'])
  const refreshedAgeDiff = await diffOf(repo, FEATURE, '  Scenario Outline:', '  # Owner decision 2026-09-23: rows weigh by business-hour age.\n')
  const partialDiff = await diffOf(repo, DECISION_FEATURE, "  Scenario: The founder's reply", '  # Owner decision 2026-09-24: partial days count as business days only.\n')
  const plannerReply = reply({
    answer: 'Two slices: the engine, then delivery.',
    status: 'done',
    slices: [{ title: 'Engine', scope: 'The pure scoring engine.', depends_on: [] }, { title: 'Delivery', scope: 'Delivery states.', depends_on: [1] }],
  })
  // First match wins, so the most specific prompt text comes first: a thread replays its history.
  const replies = [
    { match: 'Explain the founder reply.', reply: reply({ answer: 'The founder reply is a separate discussion.' }) },
    { match: 'Обнови устаревший патч из сообщения', reply: reply({ answer: 'The correction has been rebuilt against the current files.', patch: refreshedAgeDiff }) },
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
      [`${ENGINE}/change.yaml`]: 'version: 1\nkind: behavior-driven\n',
      [`${ENGINE}/proposal.md`]: '## Why\n\nThe engine.\n',
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
    'initiativeBase: initiative-base',
    'commitTrailer: "Co-Authored-By: E2E <e2e@example.com>"',
    '',
  ].join('\n'))
  const server = await startServer({ configPath: config, token: 'e2e', sandbox: new FakeSandbox() })
  closeFixture = server.close
  console.log(`e2e fixture repo: ${repo}`)
}

main().catch((error: unknown) => {
  console.error(error)
  void teardown(1)
})
