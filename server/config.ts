import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const RunnerSchema = z.object({
  worktree: z.string().min(1),
  compose: z.object({
    project: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    service: z.string().min(1),
  }),
  command: z.array(z.string().min(1)).min(1),
  watch: z.array(z.string().min(1)).min(1),
  applyAllowedTools: z.array(z.string().min(1)).min(1),
})

const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4600),
  hubRoot: z.string().default('../..'),
  repos: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).min(1),
  model: z.string().default('opus'),
  claudeBin: z.string().default('claude'),
  commitTrailer: z.string().default(''),
  questionTimeoutMinutes: z.number().positive().default(10),
  devUiOrigin: z.string().default('http://127.0.0.1:5173'),
  runners: z.record(z.string(), RunnerSchema).default({}),
})

export interface RunnerProfile {
  name: string
  worktreePath: string
  compose: { project: string; files: string[]; service: string }
  command: string[]
  watch: string[]
  applyAllowedTools: string[]
}

export interface Config {
  port: number
  hubRoot: string
  repos: { name: string; path: string }[]
  model: string
  claudeBin: string
  commitTrailer: string
  questionTimeoutMs: number
  devUiOrigin: string
  runners: RunnerProfile[]
}

export class ConfigError extends Error {}

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
    claudeBin: c.claudeBin,
    commitTrailer: c.commitTrailer,
    questionTimeoutMs: c.questionTimeoutMinutes * 60_000,
    devUiOrigin: c.devUiOrigin,
    runners: Object.entries(c.runners).map(([name, r]) => ({
      name,
      worktreePath: path.resolve(hubRoot, r.worktree),
      compose: { ...r.compose, files: r.compose.files.map((f) => path.resolve(configDir, f)) },
      command: r.command,
      watch: r.watch,
      applyAllowedTools: r.applyAllowedTools,
    })),
  }
}
