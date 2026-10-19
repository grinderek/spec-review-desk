import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export class ReviewLockError extends Error {}

const queues = new Map<string, Promise<unknown>>()
const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()

// Linux flock belongs to the shared open file description. The child acquires it on
// inherited fd 3; the parent keeps that description open until the operation finishes.
// Closing it (including on server exit) releases the lock without a stale lease file.
async function acquire(key: string): Promise<() => Promise<void>> {
  const directory = path.join(os.tmpdir(), 'spec-review-write-locks')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${createHash('sha256').update(key).digest('hex')}.lock`)
  const handle = await open(file, 'a', 0o600)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'],
        { stdio: ['ignore', 'ignore', 'pipe', handle.fd] })
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', (error) => reject(new ReviewLockError(`Cannot acquire review lock: ${error.message}. Desk writers require flock (WSL/Linux).`)))
      child.once('close', (code) => code === 0 ? resolve() : reject(new ReviewLockError(code === 75
        ? 'Another Desk process is writing this review. Retry after it finishes.'
        : `Cannot acquire review lock (${code}): ${stderr.trim()}`)))
    })
    return () => handle.close()
  } catch (error) { await handle.close(); throw error }
}

export async function withReviewLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  // Initiative locks also use this path with a file name that might not exist yet.
  let key: string
  try { key = await realpath(scope) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    key = path.join(await realpath(path.dirname(scope)), path.basename(scope))
  }
  if (held.getStore()?.get(key)?.active) return fn()
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const release = await acquire(key)
    const lease = { active: true }
    try { return await held.run(new Map([...(held.getStore() ?? []), [key, lease]]), fn) }
    finally { lease.active = false; await release() }
  })
  queues.set(key, next)
  try { return await next }
  finally { if (queues.get(key) === next) queues.delete(key) }
}
