import { type ChildProcess, spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { claudeArgs } from '../claude.ts'
import type { RunOptions, Sandbox, SandboxOutcome, SandboxRun, SandboxStatus } from '../sandbox.ts'
import { FAKE_CLAUDE } from './fake-claude-path.ts'

export const FAKE_TOKEN = 'sk-ant-oat01-fake-sandbox-token-0123456789'

// Spec B §12: the injected container runner of the integration tests — runs the fake claude
// directly against the room (cwd), the output dir (FAKE_CLAUDE_OUT) and the session dir.
export class FakeSandbox implements Sandbox {
  readonly runs: SandboxRun[] = []
  readonly cleaned: string[] = []
  statusValue: SandboxStatus = { docker: true, image: true, egressImage: true, token: true, ready: true, fixes: [] }
  tokenValue: string | null = FAKE_TOKEN
  #children = new Map<string, ChildProcess>()
  #stopped = new Set<string>()

  constructor(private readonly claudeBin: string = FAKE_CLAUDE) {}

  async status(): Promise<SandboxStatus> {
    return this.statusValue
  }

  async token(): Promise<string | null> {
    return this.tokenValue
  }

  run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
    this.runs.push(spec)
    return new Promise((resolve) => {
      const child = spawn(this.claudeBin, [...claudeArgs(spec.claude), ...(spec.extraArgs ?? [])], {
        cwd: spec.room,
        env: { ...process.env, FAKE_CLAUDE_OUT: spec.out, FAKE_CLAUDE_SESSIONS: spec.sessions },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.#children.set(spec.runId, child)
      let buffer = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, opts.timeoutMs)
      child.stdout!.on('data', (d: Buffer) => {
        buffer += d.toString()
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          opts.onLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        this.#children.delete(spec.runId)
        if (buffer.trim()) opts.onLine(buffer)
        const stopped = this.#stopped.delete(spec.runId)
        resolve({ code, timedOut, stopped, error: code === 0 || timedOut || stopped ? null : stderr.trim() || `exit ${code}` })
      })
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(spec.claude.prompt)
    })
  }

  async stop(runId: string): Promise<void> {
    this.#stopped.add(runId)
    this.#children.get(runId)?.kill('SIGTERM')
  }

  async cleanup(runId: string, runDir: string): Promise<void> {
    this.cleaned.push(runId)
    await rm(runDir, { recursive: true, force: true })
  }
}
