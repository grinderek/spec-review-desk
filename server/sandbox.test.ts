import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexRunSpec } from './codex.ts'
import type { SandboxConfig } from './config.ts'
import { DockerSandbox, readApiKey, type SandboxRun } from './sandbox.ts'
import {
  browserNetworkCreateArgs, browserOutNetworkCreateArgs, browserProxyConnectArgs, browserProxyRunArgs, browserRunArgs, egressRunArgs, networkConnectArgs,
  networkCreateArgs, outNetworkCreateArgs,
} from './sandbox-args.ts'
import { FAKE_DOCKER } from './testing/fake-codex-path.ts'

let tmp = ''
let dockerLog = ''
const TOKEN = 'sk-ant-oat01-test-token-value-1234567890'

const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  image: 'spec-review-agent:test',
  egressImage: 'spec-review-egress:test',
  browserImage: 'spec-review-browser:test',
  envFile: path.join(tmp, '.env'),
  timeoutMs: 10_000,
  dockerBin: FAKE_DOCKER,
  ...over,
})
const claude: CodexRunSpec = {
  bin: 'claude', cwd: '/work/in', sessionId: 's-1', resume: false, model: 'gpt-5.4', allowedTools: ['Read'], disallowedTools: ['Bash'],
  permissionMode: 'default', appendSystemPrompt: null, prompt: 'Plan the slices.', jsonSchema: null,
}
async function runSpec(): Promise<SandboxRun> {
  const runDir = path.join(tmp, 'runs', 'r_0000abcd')
  for (const d of ['room', 'out', 'sessions']) await mkdir(path.join(runDir, d), { recursive: true })
  return { runId: 'r_0000abcd', runDir, room: path.join(runDir, 'room'), out: path.join(runDir, 'out'), sessions: path.join(runDir, 'sessions'), domains: ['docs.stripe.com'], codex: claude }
}
const TEARDOWN = [
  'sr-r_0000abcd', 'sr-browser-r_0000abcd', 'sr-bproxy-r_0000abcd', 'sr-egress-r_0000abcd',
  'sr-bnet-r_0000abcd', 'sr-bout-r_0000abcd', 'sr-net-r_0000abcd', 'sr-out-r_0000abcd',
]
const calls = async (): Promise<{ args: string[]; stdin?: string }[]> =>
  (await readFile(dockerLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin?: string })

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-sandbox-'))
  dockerLog = path.join(tmp, 'docker.ndjson')
  await chmod(FAKE_DOCKER, 0o755)
  process.env.FAKE_DOCKER_LOG = dockerLog
  process.env.FAKE_DOCKER_STATE = path.join(tmp, 'state')
  for (const v of ['FAKE_DOCKER_DOWN', 'FAKE_DOCKER_MISSING', 'FAKE_DOCKER_EGRESS_FAIL', 'FAKE_DOCKER_BROWSER_FAIL', 'FAKE_DOCKER_BPROXY_FAIL', 'FAKE_DOCKER_BROWSER_SILENT', 'FAKE_DOCKER_HANG']) {
    delete process.env[v]
  }
  await writeFile(path.join(tmp, '.env'), `# comment\nOTHER=1\nexport OPENAI_API_KEY="${TOKEN}"\n`)
})

describe('readApiKey', () => {
  it('reads only OPENAI_API_KEY, quoted or not, and null when absent', async () => {
    expect(await readApiKey(path.join(tmp, '.env'))).toBe(TOKEN)
    await writeFile(path.join(tmp, 'plain.env'), 'OPENAI_API_KEY=abc\n')
    expect(await readApiKey(path.join(tmp, 'plain.env'))).toBe('abc')
    expect(await readApiKey(path.join(tmp, 'missing.env'))).toBeNull()
    await writeFile(path.join(tmp, 'empty.env'), 'OPENAI_API_KEY=\n')
    expect(await readApiKey(path.join(tmp, 'empty.env'))).toBeNull()
  })
})

describe('DockerSandbox.status', () => {
  it('reports docker, the three images and the token by presence only, with the exact fixes', async () => {
    expect(await new DockerSandbox(config()).status()).toEqual({
      docker: true, image: true, egressImage: true, browserImage: true, browserFix: null, token: true, ready: true, fixes: [],
    })
    process.env.FAKE_DOCKER_MISSING = 'spec-review-agent:test'
    const missing = await new DockerSandbox(config({ envFile: path.join(tmp, 'none.env') })).status()
    expect(missing).toMatchObject({ docker: true, image: false, egressImage: true, browserImage: true, token: false, ready: false })
    expect(missing.fixes).toEqual([
      'Build the sandbox images: npm run agent:build',
      'Put OPENAI_API_KEY=… into the .env next to config.yaml',
    ])
    process.env.FAKE_DOCKER_DOWN = '1'
    expect((await new DockerSandbox(config()).status()).fixes[0]).toBe('Install Docker and make sure `docker version` works')
  })

  it('stays ready without the research browser image and reports it on its own (controller ruling 1)', async () => {
    process.env.FAKE_DOCKER_MISSING = 'spec-review-browser:test'
    expect(await new DockerSandbox(config()).status()).toEqual({
      docker: true, image: true, egressImage: true, browserImage: false, browserFix: 'Build the research browser image: npm run agent:build',
      token: true, ready: true, fixes: [],
    })
    process.env.FAKE_DOCKER_DOWN = '1'
    expect(await new DockerSandbox(config()).status()).toMatchObject({ browserImage: false, browserFix: null, ready: false })
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
      'network create', 'network create', 'run -d', 'network connect', 'run --rm',
      'rm -f', 'rm -f', 'rm -f', 'rm -f', 'network rm', 'network rm', 'network rm', 'network rm',
    ])
    expect(all.slice(0, 4).map((c) => c.args)).toEqual([
      networkCreateArgs('r_0000abcd'), outNetworkCreateArgs('r_0000abcd'),
      egressRunArgs('r_0000abcd', 'spec-review-egress:test', path.join(spec.runDir, 'egress.filter')), networkConnectArgs('r_0000abcd'),
    ])
    const agent = all[4]!
    expect(agent.stdin).toBe('Plan the slices.')
    expect(agent.args).toEqual(expect.arrayContaining(['--network', 'sr-net-r_0000abcd', '--env-file', path.join(spec.runDir, 'agent.env')]))
    expect(agent.args.slice(-2)).toEqual(['--add-dir', '/work/out'])
    expect(agent.args).toContain('NO_PROXY=')
    expect(agent.args).toContain('no_proxy=')
    expect(all.slice(5).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
    await expect(stat(path.join(spec.runDir, 'browser.filter'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(agent.args.join(' ')).not.toContain(TOKEN)
    expect((await stat(path.join(spec.runDir, 'egress.filter'))).mode & 0o777).toBe(0o644)
    expect(await readFile(path.join(spec.runDir, 'egress.filter'), 'utf8')).toBe('^api\\.openai\\.com:443$\n^www\\.bing\\.com:443$\n^docs\\.stripe\\.com:443$\n')
    await expect(stat(path.join(spec.runDir, 'agent.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts the research browser behind its own proxy, waits until it listens, points the agent at it, and removes it', async () => {
    const spec = await runSpec()
    const sandbox = new DockerSandbox(config(), { browserReadyMs: 2000, pollMs: 10 })
    const outcome = await sandbox.run({ ...spec, browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome).toEqual({ code: 0, timedOut: false, stopped: false, error: null })
    const all = await calls()
    expect(all.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'network create', 'network create', 'run -d', 'network connect',
      'network create', 'network create', 'run -d', 'network connect', 'run -d', 'logs sr-browser-r_0000abcd',
      'run --rm', 'rm -f', 'rm -f', 'rm -f', 'rm -f', 'network rm', 'network rm', 'network rm', 'network rm',
    ])
    const browserFilter = path.join(spec.runDir, 'browser.filter')
    expect(all.slice(4, 9).map((c) => c.args)).toEqual([
      browserNetworkCreateArgs('r_0000abcd'),
      browserOutNetworkCreateArgs('r_0000abcd'),
      browserProxyRunArgs('r_0000abcd', 'spec-review-egress:test', browserFilter),
      browserProxyConnectArgs('r_0000abcd'),
      browserRunArgs('r_0000abcd', 'spec-review-browser:test'),
    ])
    // Controller ruling 2: the agent's proxy allows the OpenAI API, the browser's proxy never does;
    // review fix 1: both allow HTTPS to port 443 only.
    expect(await readFile(path.join(spec.runDir, 'egress.filter'), 'utf8')).toBe('^api\\.openai\\.com:443$\n^www\\.bing\\.com:443$\n^docs\\.stripe\\.com:443$\n')
    expect(await readFile(browserFilter, 'utf8')).toBe('^docs\\.stripe\\.com:443$\n')
    expect((await stat(browserFilter)).mode & 0o777).toBe(0o644)
    const agent = all[10]!
    expect(agent.args).toContain('NO_PROXY=sr-browser-r_0000abcd')
    expect(agent.args).toEqual(expect.arrayContaining(['--network', 'sr-net-r_0000abcd', '--network', 'sr-bnet-r_0000abcd']))
    expect(agent.args).toContain('mcp_servers.browser.url="http://sr-browser-r_0000abcd:8931/mcp"')
    expect(all.slice(11).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
  })

  it('fails the run without starting the browser or the agent when the browser proxy cannot start', async () => {
    process.env.FAKE_DOCKER_BPROXY_FAIL = '1'
    const outcome = await new DockerSandbox(config(), { browserReadyMs: 2000, pollMs: 10 }).run({ ...(await runSpec()), browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/research browser could not start/)
    const all = await calls()
    expect(all.some((c) => c.args.includes('-i') || (c.args[0] === 'run' && c.args.includes('sr-browser-r_0000abcd')))).toBe(false)
    expect(all.slice(-8).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
  })

  it('fails the run without starting the agent when the browser cannot start, and tears everything down', async () => {
    process.env.FAKE_DOCKER_BROWSER_FAIL = '1'
    const outcome = await new DockerSandbox(config(), { browserReadyMs: 2000, pollMs: 10 }).run({ ...(await runSpec()), browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome).toMatchObject({ code: null, error: expect.stringMatching(/research browser could not start/) })
    const all = await calls()
    expect(all.some((c) => c.args.includes('-i'))).toBe(false)
    expect(all.slice(-8).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
  })

  it('fails the run when the browser never listens', async () => {
    process.env.FAKE_DOCKER_BROWSER_SILENT = '1'
    const outcome = await new DockerSandbox(config(), { browserReadyMs: 150, pollMs: 10 }).run({ ...(await runSpec()), browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/research browser could not start: it did not listen within 0\.15 s/)
    const all = await calls()
    expect(all.some((c) => c.args.includes('-i'))).toBe(false)
    expect(all.slice(-8).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
  })

  it('never starts the agent when the run is stopped while the browser comes up', async () => {
    process.env.FAKE_DOCKER_BROWSER_SILENT = '1'
    const sandbox = new DockerSandbox(config(), { browserReadyMs: 10_000, pollMs: 10 })
    const running = sandbox.run({ ...(await runSpec()), browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    await vi.waitFor(async () => expect((await calls()).some((c) => c.args[0] === 'logs')).toBe(true))
    await sandbox.stop('r_0000abcd')
    expect(await running).toEqual({ code: null, timedOut: false, stopped: true, error: null })
    const all = await calls()
    expect(all.some((c) => c.args.includes('-i'))).toBe(false)
    expect(all.slice(-8).map((c) => c.args.at(-1))).toEqual(TEARDOWN)
  })

  it('fails the run without starting the agent when the proxy cannot start', async () => {
    process.env.FAKE_DOCKER_EGRESS_FAIL = '1'
    const outcome = await new DockerSandbox(config()).run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/egress proxy/)
    expect((await calls()).some((c) => c.args.includes('-i'))).toBe(false)
  })

  it('refuses to run without a token', async () => {
    const outcome = await new DockerSandbox(config({ envFile: path.join(tmp, 'none.env') })).run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    expect(outcome.error).toMatch(/OPENAI_API_KEY/)
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

  // A Stop while the network and the egress proxy are still being set up must not be lost: the
  // agent container is never started and the attempt ends stopped (it used to run on until done or
  // timed out — also the cause of a flake of the test above on a loaded machine).
  it('ends an attempt stopped during its setup without starting the agent container', async () => {
    process.env.FAKE_DOCKER_HANG = '1'
    const sandbox = new DockerSandbox(config())
    const running = sandbox.run(await runSpec(), { timeoutMs: 10_000, onLine: () => undefined })
    await sandbox.stop('r_0000abcd')
    expect(await running).toMatchObject({ timedOut: false, stopped: true, error: null })
    expect((await calls()).some((c) => c.args[0] === 'run' && c.args.includes('sr-r_0000abcd'))).toBe(false)
  })

  it('removes the browser when a browser run is stopped', async () => {
    process.env.FAKE_DOCKER_HANG = '1'
    const sandbox = new DockerSandbox(config(), { browserReadyMs: 2000, pollMs: 10 })
    const running = sandbox.run({ ...(await runSpec()), browser: true }, { timeoutMs: 10_000, onLine: () => undefined })
    await vi.waitFor(async () => expect((await calls()).some((c) => c.args.includes('-i'))).toBe(true))
    await sandbox.stop('r_0000abcd')
    expect(await running).toMatchObject({ stopped: true })
    const all = (await calls()).map((c) => c.args.join(' '))
    expect(all.indexOf('rm -f sr-browser-r_0000abcd')).toBeGreaterThan(all.indexOf('kill sr-r_0000abcd'))
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
    expect((await calls()).map((c) => c.args.join(' '))).toContain('rm -f sr-browser-r_0000abcd')
    const cleanup = (await calls()).find((c) => c.args.includes('none'))!
    expect(cleanup.args).toEqual(expect.arrayContaining(['--user', '10001:10001', `${spec.out}:/clean/0`, `${spec.sessions}:/clean/1`]))
    await expect(stat(spec.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
