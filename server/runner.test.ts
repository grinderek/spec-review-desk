import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RunnerProfile } from './config.ts'
import { EventBus } from './events.ts'
import type { RunOptions, RunResult } from './git.ts'
import { RESULT_FILE, RunnerService } from './runner.ts'
import { makeRepo } from './testing/repo.ts'

const RESULT = [
  { gherkinDocument: { uri: 'features/x/thread_state.feature', feature: { children: [{ scenario: { id: 's1', name: 'Plain', examples: [] } }] } } },
  { pickle: { id: 'p1', uri: 'features/x/thread_state.feature', name: 'Plain', astNodeIds: ['s1'], steps: [{ id: 'ps1', text: 'a' }] } },
  { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 'ts1', pickleStepId: 'ps1' }] } },
  { testCaseStarted: { id: 'c1', testCaseId: 'tc1' } },
  { testStepFinished: { testCaseStartedId: 'c1', testStepId: 'ts1', testStepResult: { status: 'PASSED' } } },
].map((e) => JSON.stringify(e)).join('\n')

async function setup(opts: { up?: boolean; writeResult?: boolean; gate?: Promise<void> } = {}) {
  const { repo } = await makeRepo()
  const profile: RunnerProfile = {
    name: 'pilot', worktreePath: repo,
    compose: { project: 'proj', files: ['/x/compose.yaml', '/x/bdd.yaml'], service: 'api' },
    command: ['bin/cucumber', '--format', `message:${RESULT_FILE}`], watch: ['features'], applyAllowedTools: ['Read'],
  }
  const calls: string[][] = []
  const exec = async (_cmd: string, args: readonly string[], _opts: RunOptions): Promise<RunResult> => {
    calls.push([...args])
    if (args.includes('ps')) return { stdout: opts.up === false ? '' : 'cid\n', stderr: '', code: 0 }
    if (args.includes('exec')) {
      await opts.gate
      if (opts.writeResult !== false) {
        await mkdir(path.join(repo, '.spec-review'), { recursive: true })
        await writeFile(path.join(repo, RESULT_FILE), RESULT)
        return { stdout: '', stderr: '', code: 1 }
      }
      return { stdout: '', stderr: 'boom: bundler missing', code: 2 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
  const bus = new EventBus()
  const runner = new RunnerService({ profiles: [profile], bus, exec, debounceMs: 2000 })
  return { repo, runner, calls, bus }
}

describe('RunnerService', () => {
  it('runs cucumber inside the warm container and parses the result', async () => {
    const { repo, runner, calls } = await setup()
    await runner.runNow(repo)
    expect(calls.find((c) => c.includes('exec'))).toEqual(['compose', '-p', 'proj', '-f', '/x/compose.yaml', '-f', '/x/bdd.yaml', 'exec', '-T', 'api', 'bin/cucumber', '--format', `message:${RESULT_FILE}`])
    expect(runner.state(repo)).toMatchObject({ up: true, running: false, error: null })
    expect(runner.state(repo)!.result!.scenarios['thread_state.feature::Plain']!.status).toBe('passed')
  })

  it('coalesces triggers that arrive during a run into exactly one more run', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { repo, runner, calls } = await setup({ gate })
    const first = runner.runNow(repo)
    void runner.runNow(repo)
    void runner.runNow(repo)
    release()
    await first
    await runner.idle(repo)
    expect(calls.filter((c) => c.includes('exec'))).toHaveLength(2)
  })

  it('does not run when the container is down', async () => {
    const { repo, runner, calls } = await setup({ up: false })
    await runner.runNow(repo)
    expect(calls.some((c) => c.includes('exec'))).toBe(false)
    expect(runner.state(repo)!.error).toMatch(/runner off/)
  })

  it('reports cucumber output when no result file appears', async () => {
    const { repo, runner } = await setup({ writeResult: false })
    await runner.runNow(repo)
    expect(runner.state(repo)!.error).toMatch(/boom: bundler missing/)
  })

  it('debounces file events into one run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { repo, runner, calls } = await setup()
    runner.schedule(repo)
    runner.schedule(repo)
    runner.schedule(repo)
    vi.advanceTimersByTime(2000)
    vi.useRealTimers()
    await runner.idle(repo)
    expect(calls.filter((c) => c.includes('exec'))).toHaveLength(1)
  })

  it('loads the last result on boot and publishes state changes', async () => {
    const { repo, runner, bus } = await setup()
    await mkdir(path.join(repo, '.spec-review'), { recursive: true })
    await writeFile(path.join(repo, RESULT_FILE), RESULT)
    const topics: string[] = []
    bus.subscribe('runner', (e) => topics.push(e.topic))
    await runner.loadLast(repo)
    expect(runner.state(repo)!.result!.totals.passed).toBe(1)
    expect(topics.length).toBeGreaterThan(0)
  })
})
