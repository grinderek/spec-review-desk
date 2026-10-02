import { spawn } from 'node:child_process'
import { loadConfig } from '../server/config.ts'
import { AUTH_STORE, AUTH_VOLUME } from '../server/sandbox-args.ts'

const action = process.argv[2]
if (!['login', 'logout', 'status'].includes(action ?? '')) throw new Error('Use login, logout or status')
const configIndex = process.argv.indexOf('--config')
const { sandbox } = await loadConfig(configIndex === -1 ? 'config.yaml' : process.argv[configIndex + 1]!)
const tty = process.stdin.isTTY && process.stdout.isTTY
const proxyCa = process.env.CODEX_PROXY_CERT
const args = [
  'run', '--rm', '-i', ...(tty ? ['-t'] : []),
  '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/agent:uid=10001,gid=10001',
  '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--mount', `type=volume,src=${sandbox.authVolume ?? AUTH_VOLUME},dst=${AUTH_STORE}`,
  '-e', `CODEX_HOME=${AUTH_STORE}`,
  ...(proxyCa ? ['--mount', `type=bind,src=${proxyCa},dst=/run/proxy-ca.pem,readonly`,
    '-e', 'SSL_CERT_FILE=/run/proxy-ca.pem'] : []),
  sandbox.image, 'flock', `${AUTH_STORE}/auth.lock`,
  'codex', '-c', 'cli_auth_credentials_store="file"',
  ...(action === 'logout' ? ['logout'] : ['login', action === 'login' ? '--device-auth' : 'status']),
]
// Docker's configured proxy and CA remain in effect; no host auth files are mounted.
const child = spawn(sandbox.dockerBin, args, { stdio: 'inherit' })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
