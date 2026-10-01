import { spawn } from 'node:child_process'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { codexArgs, type CodexRunSpec } from './codex.ts'
import type { SandboxConfig } from './config.ts'
import { browserFilter, egressFilter } from './egress.ts'
import { run } from './git.ts'
import {
  agentRunArgs, browserName, browserNetworkCreateArgs, browserOutNetworkCreateArgs, browserProxyConnectArgs, browserProxyRunArgs, browserRunArgs,
  cleanupArgs, containerName, egressRunArgs, networkConnectArgs, networkCreateArgs, outNetworkCreateArgs, teardownArgs,
} from './sandbox-args.ts'

// Spec B §5: one docker container per agent attempt, behind a per-run egress proxy (ruling 1).
export interface SandboxRun {
  runId: string
  runDir: string
  room: string
  out: string
  sessions: string
  domains: readonly string[]
  codex: CodexRunSpec
  extraArgs?: readonly string[]
  // The research read phase: a headless browser (Playwright MCP) next to the agent, behind its own
  // proxy (approved domains only), loaded as the agent's one MCP server.
  browser?: boolean
}
export interface SandboxOutcome { code: number | null; timedOut: boolean; stopped: boolean; error: string | null }
export interface SandboxStatus {
  docker: boolean
  image: boolean
  egressImage: boolean
  // The research browser only serves the research read phase: it is reported on its own and never
  // makes the sandbox unready (controller ruling 1). browserFix: its build hint, or null.
  browserImage: boolean
  browserFix: string | null
  token: boolean
  ready: boolean
  fixes: string[]
}
export interface DockerSandboxOptions { browserReadyMs?: number; pollMs?: number }
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
  browser: 'Build the research browser image: npm run agent:build',
  token: 'Put OPENAI_API_KEY=… into the .env next to config.yaml',
} as const

const TOKEN_LINE = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/
// The Playwright MCP server's first line (on stderr) once its HTTP endpoint accepts connections. The
// CLI connects to its MCP servers once, at startup: the agent must not start before this.
const BROWSER_LISTENING = 'Listening on '
const STOPPED: SandboxOutcome = { code: null, timedOut: false, stopped: true, error: null }

// Reads only the token line of the gitignored .env; the value is never logged or served.
export async function readApiKey(envFile: string): Promise<string | null> {
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
  readonly #browserReadyMs: number
  readonly #pollMs: number

  constructor(private readonly config: SandboxConfig, opts: DockerSandboxOptions = {}) {
    this.#browserReadyMs = opts.browserReadyMs ?? 30_000
    this.#pollMs = opts.pollMs ?? 250
  }

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
    return readApiKey(this.config.envFile)
  }

  async status(): Promise<SandboxStatus> {
    const docker = await this.#ok(['version', '--format', '{{.Client.Version}}'])
    const image = docker && (await this.#ok(['image', 'inspect', this.config.image]))
    const egressImage = docker && (await this.#ok(['image', 'inspect', this.config.egressImage]))
    const browserImage = docker && (await this.#ok(['image', 'inspect', this.config.browserImage]))
    const token = (await this.token()) !== null
    const fixes = [...(docker ? [] : [FIXES.docker]), ...(docker && !(image && egressImage) ? [FIXES.image] : []), ...(token ? [] : [FIXES.token])]
    const browserFix = docker && !browserImage ? FIXES.browser : null
    return { docker, image, egressImage, browserImage, browserFix, token, ready: fixes.length === 0, fixes }
  }

  async run(spec: SandboxRun, opts: RunOptions): Promise<SandboxOutcome> {
    // A stop() between two attempts of the same run id (a validation retry, an owner resume) must
    // not mark THIS attempt stopped: clear any stale mark before the attempt begins.
    this.#stopped.delete(spec.runId)
    const token = await this.token()
    if (!token) return { code: null, timedOut: false, stopped: false, error: `no OPENAI_API_KEY in ${this.config.envFile}` }
    const envFile = path.join(spec.runDir, 'agent.env')
    const filterFile = path.join(spec.runDir, 'egress.filter')
    await writeFile(envFile, `CODEX_API_KEY=${token}\n`, { mode: 0o600 })
    await writeFile(filterFile, egressFilter(spec.domains), { mode: 0o644 })
    await chmod(filterFile, 0o644)
    try {
      try {
        await this.#docker(networkCreateArgs(spec.runId))
        await this.#docker(outNetworkCreateArgs(spec.runId))
        await this.#docker(egressRunArgs(spec.runId, this.config.egressImage, filterFile))
        await this.#docker(networkConnectArgs(spec.runId))
      } catch (error) {
        return { code: null, timedOut: false, stopped: false, error: `the egress proxy could not start: ${(error as Error).message}` }
      }
      // A stop() during the setup above found no agent container to kill: honour it here instead
      // of starting the agent (it would otherwise run until it finished or timed out).
      if (this.#stopped.delete(spec.runId)) return STOPPED
      if (spec.browser) {
        const problem = await this.#startBrowser(spec)
        if (problem) return { code: null, timedOut: false, stopped: false, error: `the research browser could not start: ${problem}` }
        // The same for a stop while the browser came up: the agent never starts.
        if (this.#stopped.delete(spec.runId)) return STOPPED
      }
      const schemaFile = path.join(spec.runDir, 'reply-schema.json')
      if (spec.codex.jsonSchema) {
        await writeFile(schemaFile, spec.codex.jsonSchema, { mode: 0o644 })
        await chmod(schemaFile, 0o644)
      }
      const args = agentRunArgs({
        runId: spec.runId,
        image: this.config.image,
        envFile,
        schemaFile: spec.codex.jsonSchema ? schemaFile : undefined,
        room: spec.room,
        out: spec.out,
        sessions: spec.sessions,
        codexArgs: [...codexArgs({ ...spec.codex, schemaFile: '/work/reply-schema.json', toolsScript: '/opt/spec-review/desk-tools.mjs' }), ...(spec.extraArgs ?? [])],
        browser: spec.browser === true,
      })
      return await this.#attach(spec, args, opts)
    } finally {
      await rm(envFile, { force: true })
      for (const args of teardownArgs(spec.runId)) await this.#ok(args)
    }
  }

  // Starts the browser network, its proxy and sr-browser-<run>, then waits until the MCP endpoint
  // listens; the problem, or null when ready.
  async #startBrowser(spec: SandboxRun): Promise<string | null> {
    const { runId } = spec
    const filterFile = path.join(spec.runDir, 'browser.filter')
    try {
      await writeFile(filterFile, browserFilter(spec.domains), { mode: 0o644 })
      await chmod(filterFile, 0o644)
      await this.#docker(browserNetworkCreateArgs(runId))
      await this.#docker(browserOutNetworkCreateArgs(runId))
      await this.#docker(browserProxyRunArgs(runId, this.config.egressImage, filterFile))
      await this.#docker(browserProxyConnectArgs(runId))
      await this.#docker(browserRunArgs(runId, this.config.browserImage))
    } catch (error) {
      return (error as Error).message
    }
    const deadline = Date.now() + this.#browserReadyMs
    for (;;) {
      const logs = await this.#docker(['logs', browserName(runId)], true).catch(() => null)
      if (logs && `${logs.stdout}${logs.stderr}`.includes(BROWSER_LISTENING)) return null
      if (this.#stopped.has(runId)) return null
      if (Date.now() >= deadline) return `it did not listen within ${this.#browserReadyMs / 1000} s`
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs))
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
      child.stdin.end(spec.codex.prompt)
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
