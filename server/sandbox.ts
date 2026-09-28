import { spawn } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { claudeArgs, type ClaudeRunSpec } from './claude.ts'
import type { SandboxConfig } from './config.ts'
import { egressFilter } from './egress.ts'
import { run } from './git.ts'
import {
  agentRunArgs, cleanupArgs, containerName, egressRunArgs, networkConnectArgs, networkCreateArgs, teardownArgs,
} from './sandbox-args.ts'

// Spec B §5: one docker container per agent attempt, behind a per-run egress proxy (ruling 1).
export interface SandboxRun {
  runId: string
  runDir: string
  room: string
  out: string
  sessions: string
  domains: readonly string[]
  claude: ClaudeRunSpec
  extraArgs?: readonly string[]
}
export interface SandboxOutcome { code: number | null; timedOut: boolean; stopped: boolean; error: string | null }
export interface SandboxStatus { docker: boolean; image: boolean; egressImage: boolean; token: boolean; ready: boolean; fixes: string[] }
export interface RunOptions { timeoutMs: number; onLine: (line: string) => void }

export interface Sandbox {
  status(): Promise<SandboxStatus>
  token(): Promise<string | null>
  run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome>
  stop(runId: string): Promise<void>
  cleanup(runId: string, runDir: string): Promise<void>
}

export const FIXES = {
  docker: 'Install Docker and make sure `docker version` works',
  image: 'Build the sandbox images: npm run agent:build',
  token: 'Create a token with `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN=… into tools/spec-review/.env',
} as const

const TOKEN_LINE = /^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*)$/

// Reads only the token line of the gitignored .env; the value is never logged or served.
export async function readOAuthToken(envFile: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(envFile, 'utf8')
  } catch {
    return null
  }
  const raw = text.split('\n').map((l) => TOKEN_LINE.exec(l)?.[1]).find((v) => v !== undefined)
  const value = raw?.trim().replace(/^(['"])(.*)\1$/, '$2') ?? ''
  return value || null
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export class DockerSandbox implements Sandbox {
  #stopped = new Set<string>()

  constructor(private readonly config: SandboxConfig) {}

  #docker(args: readonly string[], allowFailure = false) {
    return run(this.config.dockerBin, args, { cwd: process.cwd(), timeoutMs: 60_000, allowFailure })
  }

  async #ok(args: readonly string[]): Promise<boolean> {
    try {
      return (await this.#docker(args, true)).code === 0
    } catch {
      return false
    }
  }

  token(): Promise<string | null> {
    return readOAuthToken(this.config.envFile)
  }

  async status(): Promise<SandboxStatus> {
    const docker = await this.#ok(['version', '--format', '{{.Client.Version}}'])
    const image = docker && (await this.#ok(['image', 'inspect', this.config.image]))
    const egressImage = docker && (await this.#ok(['image', 'inspect', this.config.egressImage]))
    const token = (await this.token()) !== null
    const fixes = [...(docker ? [] : [FIXES.docker]), ...(docker && !(image && egressImage) ? [FIXES.image] : []), ...(token ? [] : [FIXES.token])]
    return { docker, image, egressImage, token, ready: fixes.length === 0, fixes }
  }

  async run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
    // A stop() between two attempts of the same run id (a validation retry, an owner resume) must
    // not mark THIS attempt stopped: clear any stale mark before the attempt begins.
    this.#stopped.delete(spec.runId)
    const token = await this.token()
    if (!token) return { code: null, timedOut: false, stopped: false, error: `no CLAUDE_CODE_OAUTH_TOKEN in ${this.config.envFile}` }
    const envFile = path.join(spec.runDir, 'agent.env')
    const filterFile = path.join(spec.runDir, 'egress.filter')
    await writeFile(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, { mode: 0o600 })
    await writeFile(filterFile, egressFilter(spec.domains), { mode: 0o644 })
    try {
      try {
        await this.#docker(networkCreateArgs(spec.runId))
        await this.#docker(egressRunArgs(spec.runId, this.config.egressImage, filterFile))
        await this.#docker(networkConnectArgs(spec.runId))
      } catch (error) {
        return { code: null, timedOut: false, stopped: false, error: `the egress proxy could not start: ${(error as Error).message}` }
      }
      // A stop() during the setup above found no agent container to kill: honour it here instead
      // of starting the agent (it would otherwise run until it finished or timed out).
      if (this.#stopped.delete(spec.runId)) return { code: null, timedOut: false, stopped: true, error: null }
      const args = agentRunArgs({
        runId: spec.runId,
        image: this.config.image,
        envFile,
        room: spec.room,
        out: spec.out,
        sessions: spec.sessions,
        claudeArgs: [...claudeArgs(spec.claude), ...(spec.extraArgs ?? [])],
      })
      return await this.#attach(spec, args, opts)
    } finally {
      await rm(envFile, { force: true })
      for (const args of teardownArgs(spec.runId)) await this.#ok(args)
    }
  }

  #attach(spec: SandboxRun, args: readonly string[], opts: RunOptions): Promise<SandboxOutcome> {
    return new Promise((resolve) => {
      const child = spawn(this.config.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let buffer = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void this.#ok(['kill', containerName(spec.runId)])
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
      }, opts.timeoutMs)
      child.stdout.on('data', (d: Buffer) => {
        buffer += d.toString()
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          opts.onLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, timedOut: false, stopped: false, error: error.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (buffer.trim()) opts.onLine(buffer)
        const stopped = this.#stopped.delete(spec.runId)
        const failed = code !== 0 && !timedOut && !stopped
        resolve({ code, timedOut, stopped, error: failed ? stderr.trim().slice(0, 2000) || `docker exited with code ${code}` : null })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(spec.claude.prompt)
    })
  }

  async stop(runId: string): Promise<void> {
    this.#stopped.add(runId)
    await this.#ok(['kill', containerName(runId)])
  }

  async cleanup(runId: string, runDir: string): Promise<void> {
    for (const args of teardownArgs(runId)) await this.#ok(args)
    const dirs = [path.join(runDir, 'out'), path.join(runDir, 'sessions')]
    const present = (await Promise.all(dirs.map(async (d) => ((await exists(d)) ? [d] : [])))).flat()
    if (present.length) await this.#ok(cleanupArgs(this.config.image, present))
    await rm(runDir, { recursive: true, force: true }).catch((error: unknown) => console.error(error))
  }
}
