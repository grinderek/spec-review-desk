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

describe('sandbox settings (spec B §5)', () => {
  it('defaults to the pinned agent image, the egress and browser images, a 30-minute timeout and the .env next to the config', async () => {
    const file = await writeConfig('repos: [{ name: api, path: api }]')
    const config = await loadConfig(file)
    expect(config.sandbox).toEqual({
      image: 'spec-review-agent:2.1.280',
      egressImage: 'spec-review-egress:1',
      browserImage: 'spec-review-browser:0.0.80',
      envFile: path.join(path.dirname(file), '.env'),
      timeoutMs: 30 * 60_000,
      dockerBin: 'docker',
    })
    expect(config).toMatchObject({ openspecBin: 'openspec', initiativeBase: 'staging' })
  })

  it('reads overrides', async () => {
    const file = await writeConfig('repos: [{ name: api, path: api }]\nsandbox: { envFile: secrets/agent.env, timeoutMinutes: 5 }\nopenspecBin: /x/openspec\ninitiativeBase: main\n')
    const config = await loadConfig(file)
    expect(config.sandbox).toMatchObject({ envFile: path.join(path.dirname(file), 'secrets/agent.env'), timeoutMs: 300_000 })
    expect(config).toMatchObject({ openspecBin: '/x/openspec', initiativeBase: 'main' })
  })
})
