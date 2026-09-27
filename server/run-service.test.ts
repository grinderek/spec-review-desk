import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeRunSpec } from './claude.ts'
import { resetFakeClaude } from './testing/fake-claude-path.ts'
import { FakeSandbox } from './testing/fake-sandbox.ts'

const claude: ClaudeRunSpec = {
  bin: 'claude', cwd: '/work/in', sessionId: 's-1', resume: false, model: 'opus', allowedTools: ['Read'],
  disallowedTools: ['Bash'], permissionMode: 'default', appendSystemPrompt: null, prompt: 'Plan the slices.', jsonSchema: null,
}

beforeEach(() => {
  resetFakeClaude()
  delete process.env.FAKE_CLAUDE_LOG
  process.env.FAKE_CLAUDE_MODE = 'answer'
})

// Review Minor #4: a stop() issued when no attempt of a run id is in flight (between a validation
// retry and its relaunch, or between a "needs_owner" run and its Resume) must not leak into a LATER
// attempt of the same run id and make a normal completion look like it was stopped.
describe('FakeSandbox.run', () => {
  it('clears a stale stop mark from an earlier out-of-band stop before a new attempt begins', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-fake-sandbox-'))
    const sandbox = new FakeSandbox()
    await sandbox.stop('r_stale') // no attempt in flight yet — the mark must not linger
    const outcome = await sandbox.run(
      { runId: 'r_stale', runDir: tmp, room: tmp, out: tmp, sessions: tmp, domains: [], claude },
      { timeoutMs: 10_000, onLine: () => undefined },
    )
    expect(outcome).toMatchObject({ stopped: false, code: 0 })
  })
})
