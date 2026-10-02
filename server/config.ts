import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { AGENT_IMAGE, BROWSER_IMAGE, EGRESS_IMAGE } from './sandbox-args.ts'

const ReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export type AgentRole = 'research' | 'planner' | 'author' | 'reviewer' | 'apply'
const AgentProfileSchema = z.object({
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
})
export interface AgentProfile { model?: string; reasoningEffort?: ReasoningEffort }

const RunnerSchema = z.object({
  worktree: z.string().min(1),
  execution: z.enum(['compose', 'local']).default('compose'),
  compose: z.object({
    project: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    service: z.string().min(1),
  }).optional(),
  command: z.array(z.string().min(1)).min(1),
  watch: z.array(z.string().min(1)).min(1),
  applyAllowedTools: z.array(z.string().min(1)).min(1),
}).refine((r) => r.execution === 'local' || r.compose !== undefined, 'compose settings are required for a compose runner')

const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4600),
  hubRoot: z.string().default('../..'),
  repos: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).min(1),
  model: z.string().min(1).default('gpt-6.1-sol'),
  reasoningEffort: ReasoningEffortSchema.default('high'),
  agents: z.object({
    research: AgentProfileSchema.optional(),
    planner: AgentProfileSchema.optional(),
    author: AgentProfileSchema.optional(),
    reviewer: AgentProfileSchema.optional(),
    apply: AgentProfileSchema.optional(),
  }).default({}),
  routing: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().refine((s) => { const u = new URL(s); return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash }, 'routing endpoint must be a loopback HTTP origin').default('http://127.0.0.1:8009'),
    startCommand: z.array(z.string().min(1)).min(1).optional(),
    roles: z.array(z.enum(['research', 'apply'])).default(['research', 'apply']),
    timeoutMs: z.number().int().min(100).max(30000).default(5000),
    minLunaProbability: z.number().min(0).max(1).default(0.55),
  }).default({ enabled: false, endpoint: 'http://127.0.0.1:8009', roles: ['research', 'apply'], timeoutMs: 5000, minLunaProbability: 0.55 }),
  codexBin: z.string().default('codex'),
  commitTrailer: z.string().default(''),
  questionTimeoutMinutes: z.number().positive().default(10),
  devUiOrigin: z.string().default('http://127.0.0.1:5173'),
  runners: z.record(z.string(), RunnerSchema).default({}),
  // Spec B §5: the sandboxed research/planner/author runs.
  sandbox: z
    .object({
      image: z.string().min(1).default(AGENT_IMAGE),
      egressImage: z.string().min(1).default(EGRESS_IMAGE),
      browserImage: z.string().min(1).default(BROWSER_IMAGE),
      auth: z.enum(['chatgpt', 'api']).default('chatgpt'),
      authVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).default('spec-review-codex-auth'),
      envFile: z.string().min(1).default('.env'),
      timeoutMinutes: z.number().positive().default(30),
      dockerBin: z.string().min(1).default('docker'),
    })
    .default({ image: AGENT_IMAGE, egressImage: EGRESS_IMAGE, browserImage: BROWSER_IMAGE, envFile: '.env', auth: 'chatgpt', authVolume: 'spec-review-codex-auth', timeoutMinutes: 30, dockerBin: 'docker' }),
  openspecBin: z.string().min(1).default('openspec'),
  initiativeBase: z.string().min(1).default('staging'),
})

export interface SandboxConfig { auth?: 'chatgpt' | 'api'; authVolume?: string; image: string; egressImage: string; browserImage: string; envFile: string; timeoutMs: number; dockerBin: string }

export interface RunnerProfile {
  name: string
  worktreePath: string
  execution?: 'compose' | 'local'
  compose?: { project: string; files: string[]; service: string }
  command: string[]
  watch: string[]
  applyAllowedTools: string[]
}

export interface Config {
  port: number
  hubRoot: string
  repos: { name: string; path: string }[]
  model: string
  reasoningEffort?: ReasoningEffort
  agents?: Partial<Record<AgentRole, AgentProfile>>
  routing?: { enabled: boolean; endpoint: string; roles: AgentRole[]; startCommand?: string[]; timeoutMs: number; minLunaProbability: number }
  usageDir?: string
  codexBin: string
  commitTrailer: string
  questionTimeoutMs: number
  devUiOrigin: string
  runners: RunnerProfile[]
  sandbox: SandboxConfig
  openspecBin: string
  initiativeBase: string
}

export class ConfigError extends Error {}

export function agentProfile(config: Config, role: AgentRole): { model: string; reasoningEffort: ReasoningEffort } {
  const override = config.agents?.[role]
  return {
    model: override?.model ?? config.model,
    reasoningEffort: override?.reasoningEffort ?? config.reasoningEffort ?? 'high',
  }
}

export async function loadConfig(file: string): Promise<Config> {
  const configDir = path.dirname(path.resolve(file))
  const result = ConfigSchema.safeParse(parse(await readFile(file, 'utf8')))
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new ConfigError(`${file}: ${issues.join('; ')}`)
  }
  const c = result.data
  const hubRoot = path.resolve(configDir, c.hubRoot)
  return {
    port: c.port,
    hubRoot,
    repos: c.repos.map((r) => ({ name: r.name, path: path.resolve(hubRoot, r.path) })),
    model: c.model,
    reasoningEffort: c.reasoningEffort,
    agents: c.agents,
    routing: { ...c.routing, endpoint: c.routing.endpoint.replace(/\/$/, '') },
    usageDir: path.join(configDir, '.spec-review', 'usage'),
    codexBin: c.codexBin,
    commitTrailer: c.commitTrailer,
    questionTimeoutMs: c.questionTimeoutMinutes * 60_000,
    devUiOrigin: c.devUiOrigin,
    runners: Object.entries(c.runners).map(([name, r]) => ({
      name,
      worktreePath: path.resolve(hubRoot, r.worktree),
      execution: r.execution,
      compose: r.compose ? { ...r.compose, files: r.compose.files.map((f) => path.resolve(configDir, f)) } : undefined,
      command: r.command,
      watch: r.watch,
      applyAllowedTools: r.applyAllowedTools,
    })),
    sandbox: {
      auth: c.sandbox.auth,
      authVolume: c.sandbox.authVolume,
      image: c.sandbox.image,
      egressImage: c.sandbox.egressImage,
      browserImage: c.sandbox.browserImage,
      // The token file lives next to config.yaml (tools/spec-review/.env, gitignored).
      envFile: path.resolve(configDir, c.sandbox.envFile),
      timeoutMs: c.sandbox.timeoutMinutes * 60_000,
      dockerBin: c.sandbox.dockerBin,
    },
    openspecBin: c.openspecBin,
    initiativeBase: c.initiativeBase,
  }
}
