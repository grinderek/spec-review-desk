// Offline integration check: no real account, tokens, model requests or host auth mounts.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { AGENT_IMAGE, AUTH_STORE, SESSION_STORE } from '../server/sandbox-args.ts'

const volume = `sr-auth-test-${randomUUID()}`
const containers: string[] = []
const base = ['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp',
  '--tmpfs', '/home/agent:uid=10001,gid=10001',
  '--mount', `type=volume,src=${volume},dst=${AUTH_STORE}`, '-e', `CODEX_HOME=${SESSION_STORE}`]
function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'docker failed')
  return result.stdout + result.stderr
}
function node(script: string): void { docker([...base, AGENT_IMAGE, 'node', '-e', script]) }
function agent(script: string) {
  const name = `${volume}-${containers.length}`
  containers.push(name)
  const child = spawn('docker', [...base, '--name', name, '-e', 'DESK_CHATGPT_AUTH=1', AGENT_IMAGE, 'node', '-e', script], { timeout: 20_000 })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const done = once(child, 'close').then(([code]) => {
    if (code !== 0) throw new Error(stderr || `agent exited ${code}`)
    return stdout
  })
  return { child, done }
}
try {
  node(`const fs = require('fs'); const jwt = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const id = jwt({alg:'none'})+'.'+jwt({sub:'fixture', 'https://api.openai.com/auth':
      {chatgpt_account_id:'fixture',chatgpt_plan_type:'plus'}})+'.fixture';
    fs.writeFileSync('${AUTH_STORE}/auth.json', JSON.stringify({auth_mode:'chatgpt', tokens:
      {id_token:id,access_token:'fixture-access',refresh_token:'fixture-refresh',account_id:'fixture'}}), {mode:0o600});
    if ((fs.statSync('${AUTH_STORE}').mode & 511) !== 448) throw Error('unsafe credential directory permissions');`)
  const status = docker([...base, '-e', 'DESK_CHATGPT_AUTH=1', AGENT_IMAGE, 'codex', 'login', 'status'])
  if (!status.includes('ChatGPT')) throw new Error('CLI did not read the subscription login')
  const first = agent(`const fs = require('fs'); const p=process.env.CODEX_HOME+'/auth.json';
    const a=JSON.parse(fs.readFileSync(p)); console.log('locked');
    setTimeout(() => {a.tokens.refresh_token='fixture-refreshed'; fs.writeFileSync(p,JSON.stringify(a))}, 1500);`)
  await once(first.child.stdout, 'data', { signal: AbortSignal.timeout(20_000) })
  const second = agent(`const a=JSON.parse(require('fs').readFileSync(process.env.CODEX_HOME+'/auth.json'));
    if(a.tokens.refresh_token!=='fixture-refreshed') throw Error('stale refresh token'); console.log('fresh');`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (second.child.exitCode !== null) throw new Error('concurrent agent did not wait for the credential lock')
  await first.done
  if ((await second.done).trim() !== 'fresh') throw new Error('refreshed credentials not visible')
  node(`if(JSON.parse(require('fs').readFileSync('${AUTH_STORE}/auth.json')).tokens.refresh_token!=='fixture-refreshed')
    throw Error('refreshed login was not persisted');`)
  docker([...base, '-e', `CODEX_HOME=${AUTH_STORE}`, AGENT_IMAGE,
    'flock', `${AUTH_STORE}/auth.lock`, 'codex', 'logout'])
  node(`if(require('fs').existsSync('${AUTH_STORE}/auth.json')) throw Error('logout retained credentials')`)
  console.log('PASS: CLI reads ChatGPT login; credentials remain private; shared writes persist; agents serialize; logout removes login.')
} finally {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], { timeout: 20_000, stdio: 'ignore' })
  docker(['volume', 'rm', volume])
}
