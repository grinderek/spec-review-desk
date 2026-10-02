import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import { usagePath } from './agent-usage.ts'
export async function routerStatus(config: Config) {
  if (!config.routing?.enabled) return { enabled: false, ready: false }
  try {
    const r = await fetch(config.routing.endpoint + '/v1/models', { signal: AbortSignal.timeout(1500), redirect: 'error' })
    const data = await r.json() as { models?: { name: string; description?: string; run?: string }[] }
    return { enabled: true, ready: r.ok && Array.isArray(data.models) && data.models.length > 0, model: data.models?.[0]?.run ?? data.models?.[0]?.name }
  } catch { return { enabled: true, ready: false } }
}
export async function startRouter(config: Config): Promise<() => void> {
  if (!config.routing?.enabled || !config.routing.startCommand || (await routerStatus(config)).ready) return () => undefined
  const dir = path.dirname(usagePath(config))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fd = openSync(path.join(dir, 'kev-runtime.log'), 'a', 0o600)
  const [bin, ...args] = config.routing.startCommand
  const child = spawn(bin!, args, { stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.on('error', () => console.warn('Kev could not start; configured fallback profiles remain available.'))
  for (let i = 0; i < 10 && child.exitCode === null; i++) {
    if ((await routerStatus(config)).ready) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  process.once('exit', stop)
  return () => { process.removeListener('exit', stop); stop() }
}
