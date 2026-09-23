import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

async function writeConfig(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sr-config-'))
  const file = path.join(dir, 'config.yaml')
  await writeFile(file, body)
  return file
}

describe('loadConfig', () => {
  it('resolves hub paths against hubRoot and compose files against the config file', async () => {
    const file = await writeConfig(`
hubRoot: ../hub
repos: [{ name: api, path: api }]
runners:
  pilot:
    worktree: api/wt
    compose: { project: p, files: [compose/bdd.yaml], service: api }
    command: [bin/cucumber]
    watch: [features]
    applyAllowedTools: [Read]
`)
    const dir = path.dirname(file)
    const config = await loadConfig(file)
    expect(config.hubRoot).toBe(path.resolve(dir, '../hub'))
    expect(config.repos).toEqual([{ name: 'api', path: path.resolve(dir, '../hub/api') }])
    expect(config.runners[0]).toMatchObject({ name: 'pilot', worktreePath: path.resolve(dir, '../hub/api/wt') })
    expect(config.runners[0]!.compose.files).toEqual([path.resolve(dir, 'compose/bdd.yaml')])
  })

  it('applies defaults', async () => {
    const config = await loadConfig(await writeConfig('repos: [{ name: api, path: api }]'))
    expect(config).toMatchObject({ port: 4600, model: 'opus', claudeBin: 'claude', questionTimeoutMs: 600_000, runners: [] })
  })

  it('rejects a config without repos', async () => {
    await expect(loadConfig(await writeConfig('port: 4600'))).rejects.toBeInstanceOf(ConfigError)
  })
})
