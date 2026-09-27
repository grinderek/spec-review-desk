import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeRunSpec } from './claude.ts'
import type { SandboxConfig } from './config.ts'
import { DockerSandbox, readOAuthToken, type SandboxRun } from './sandbox.ts'
import { FAKE_DOCKER } from './testing/fake-claude-path.ts'

let tmp = ''
let dockerLog = ''
const TOKEN = 'sk-ant-oat01-test-token-value-1234567890'

const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  image: 'spec-review-agent:test',
  egressImage: 'spec-review-egress:test',
  envFile: path.join(tmp, '.env'),
  timeoutMs: 10_000,
  dockerBin: FAKE_DOCKER,
  ...over,
})
const claude: ClaudeRunSpec = {
  bin: 'claude', cwd: '/work/in', sessionId: 's-1', resume: false, model: 'opus', allowedTools: ['Read'], disallowedTools: ['Bash'],
  permissionMode: 'default', appendSystemPrompt: null, prompt: 'Plan the slices.', jsonSchema: null,
}
async function runSpec(): Promise<SandboxRun> {
  const runDir = path.join(tmp, 'runs', 'r_0000abcd')
  for (const d of ['room', 'out', 'sessions']) await mkdir(path.join(runDir, d), { recursive: true })
  return { runId: 'r_0000abcd', runDir, room: path.join(runDir, 'room'), out: path.join(runDir, 'out'), sessions: path.join(runDir, 'sessions'), domains: ['docs.stripe.com'], claude }
}
const calls = async (): Promise<{ args: string[]; stdin?: string }[]> =>
  (await readFile(dockerLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin?: string })

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-sandbox-'))
  dockerLog = path.join(tmp, 'docker.ndjson')
  await chmod(FAKE_DOCKER, 0o755)
  process.env.FAKE_DOCKER_LOG = dockerLog
  process.env.FAKE_DOCKER_STATE = path.join(tmp, 'state')
  for (const v of ['FAKE_DOCKER_DOWN', 'FAKE_DOCKER_MISSING', 'FAKE_DOCKER_EGRESS_FAIL', 'FAKE_DOCKER_HANG']) delete process.env[v]
  await writeFile(path.join(tmp, '.env'), `# comment\nOTHER=1\nexport CLAUDE_CODE_OAUTH_TOKEN="${TOKEN}"\n`)
})

describe('readOAuthToken', () => {
  it('reads only CLAUDE_CODE_OAUTH_TOKEN, quoted or not, and null when absent', async () => {
    expect(await readOAuthToken(path.join(tmp, '.env'))).toBe(TOKEN)
    await writeFile(path.join(tmp, 'plain.env'), 'CLAUDE_CODE_OAUTH_TOKEN=abc\n')
    expect(await readOAuthToken(path.join(tmp, 'plain.env'))).toBe('abc')
    expect(await readOAuthToken(path.join(tmp, 'missing.env'))).toBeNull()
    await writeFile(path.join(tmp, 'empty.env'), 'CLAUDE_CODE_OAUTH_TOKEN=\n')
    expect(await readOAuthToken(path.join(tmp, 'empty.env'))).toBeNull()
  })
})

describe('DockerSandbox.status', () => {
  it('reports docker, both images and the token by presence only, with the exact fixes', async () => {
    expect(await new DockerSandbox(config()).status()).toEqual({ docker: true, image: true, egressImage: true, token: true, ready: true, fixes: [] })
    process.env.FAKE_DOCKER_MISSING = 'spec-review-agent:test'
    const missing = await new DockerSandbox(config({ envFile: path.join(tmp, 'none.env') })).status()
    expect(missing).toMatchObject({ docker: true, image: false, egressImage: true, token: false, ready: false })
    expect(missing.fixes).toEqual([
      'Build the sandbox images: npm run agent:build',
      'Create a token with `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN=… into tools/spec-review/.env',
    ])
    process.env.FAKE_DOCKER_DOWN = '1'
    expect((await new DockerSandbox(config()).status()).fixes[0]).toBe('Install Docker and make sure `docker version` works')
  })
})

describe('DockerSandbox.run', () => {
  it('creates the network and the proxy, runs the agent with the prompt on stdin, and tears everything down', async () => {
    const spec = await runSpec()
    const lines: string[] = []
    const outcome = await new DockerSandbox(config()).run({ ...spec, extraArgs: ['--add-dir', '/work/out'] }, { timeoutMs: 10_000, onLine: (l) => lines.push(l) })
    expect(outcome).toEqual({ code: 0, timedOut: false, stopped: false, error: null })
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['system', 'result'])
    const all = await calls()
    expect(all.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'network create', 'run -d', 'network connect', 'run --rm', 'rm -f', 'rm -f', 'network rm',
    ])
    const agent = all[3]!
    expect(agent.stdin).toBe('Plan the slices.')
    expect(agent.args).toEqual(expect.arrayContaining(['--network', 'sr-net-r_0000abcd', '--env-file', path.join(spec.runDir, 'agent.env')]))
    expect(agent.args.slice(-2)).toEqual(['--add-dir', '/work/out'])
    expect(agent.args.join(' ')).not.toContain(TOKEN)
    expect(await readFile(path.join(spec.runDir, 'egress.filter'), 'utf8')).toBe('^api\\.anthropic\\.com$\n^docs\\.stripe\\.com$\n')
    await expect(stat(path.join(spec.runDir, 'agent.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails the run without starting the agent when the proxy cannot start', async () => {
    process.env.FAKE_DOCKER_EGRESS_FAIL = '1'
    const outcome = await new DockerSandbox(config()).run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/egress proxy/)
    expect((await calls()).some((c) => c.args.includes('-i'))).toBe(false)
  })

  it('refuses to run without a token', async () => {
    const outcome = await new DockerSandbox(config({ envFile: path.join(tmp, 'none.env') })).run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    await expect(readFile(dockerLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kills the container on timeout and on stop', async () => {
    process.env.FAKE_DOCKER_HANG = '1'
    const timed = await new DockerSandbox(config()).run(await runSpec(), { timeoutMs: 300, onLine: () => undefined })
    expect(timed).toMatchObject({ timedOut: true, stopped: false })
    const sandbox = new DockerSandbox(config())
    const running = sandbox.run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    await new Promise((r) => setTimeout(r, 300))
    await sandbox.stop('r_0000abcd')
    expect(await running).toMatchObject({ timedOut: false, stopped: true })
    expect((await calls()).filter((c) => c.args[0] === 'kill').map((c) => c.args[1])).toEqual(['sr-r_0000abcd', 'sr-r_0000abcd'])
  })

  it('does not carry a stop mark from an earlier out-of-band stop into a later attempt of the same run id', async () => {
    const sandbox = new DockerSandbox(config())
    await sandbox.stop('r_0000abcd') // no attempt in flight yet — the mark must not linger
    const outcome = await sandbox.run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome).toMatchObject({ stopped: false, code: 0 })
  })
})

describe('DockerSandbox.cleanup', () => {
  it('empties out and sessions as the agent user, then removes the run directory', async () => {
    const spec = await runSpec()
    await writeFile(path.join(spec.out, 'x.md'), 'x')
    await new DockerSandbox(config()).cleanup(spec.runId, spec.runDir)
    const cleanup = (await calls()).find((c) => c.args.includes('none'))!
    expect(cleanup.args).toEqual(expect.arrayContaining(['--user', '10001:10001', `${spec.out}:/clean/0`, `${spec.sessions}:/clean/1`]))
    await expect(stat(spec.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
