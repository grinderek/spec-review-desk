import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

export const MAX_EFFECT_INLINE_FILE_BYTES = 4 * 1024 * 1024
export const MAX_EFFECT_INLINE_TOTAL_BYTES = 16 * 1024 * 1024
export const MAX_EFFECT_SOURCE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_EFFECT_SOURCE_UNIQUE_BYTES = 100 * 1024 * 1024
// Immutable blobs and their materialized input views can each appear as explicit outputs.
export const MAX_EFFECT_SOURCE_OUTPUT_BYTES = 2 * MAX_EFFECT_SOURCE_UNIQUE_BYTES
export const MAX_EFFECT_PATHS = 1000
export interface EffectSource { path: string; hash: string }
export interface RecordedEffectSource { path: string; bytes: number }
export interface EffectContentState { hash: string; mode: 0o644 | 0o755; bytes: number }
export const isSafeEffectPath = (value: string): boolean => value.length > 0 && !/[\\\0\r\n]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

export async function checkedEffectPath(root: string, relative: string): Promise<string> {
  if (!isSafeEffectPath(relative) || relative.length > 4096) throw new Error(`Unsafe Git effect path: ${relative}`)
  let current = root
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error(`Git effect path is not a regular file with directory parents: ${relative}`)
      if (index < parts.length - 1) {
        try { await lstat(path.join(current, '.git')); throw new Error(`Git effect path crosses a nested repository: ${relative}`) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return current
}

// Hashing and copying share the same bounded read. No full-sized Buffer is retained.
async function inspect(root: string, relative: string, maxBytes: number, consume?: (bytes: Buffer) => Promise<void>, requireGitMode = true): Promise<{ hash: string; mode: number; bytes: number } | null> {
  const file = await checkedEffectPath(root, relative)
  let handle: FileHandle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const info = await handle.stat(), mode = info.mode & 0o777
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o7000) || (requireGitMode && mode !== 0o644 && mode !== 0o755)) throw new Error(`Unsupported Git effect file or size: ${relative}`)
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let bytes = 0
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maxBytes) throw new Error(`Git effect file exceeds its size limit: ${relative}`)
      const chunk = buffer.subarray(0, read.bytesRead)
      digest.update(chunk)
      await consume?.(chunk)
    }
    return { hash: digest.digest('hex'), mode, bytes }
  } finally { await handle.close() }
}
export async function inspectEffectFile(root: string, relative: string, maxBytes = MAX_EFFECT_SOURCE_FILE_BYTES): Promise<EffectContentState | null> {
  const state = await inspect(root, relative, maxBytes)
  return state as EffectContentState | null
}

export async function verifyEffectSource(root: string, source: EffectSource, expectedBytes?: number): Promise<{ hash: string; bytes: number }> {
  if (!/^[0-9a-f]{64}$/.test(source.hash) || path.posix.basename(source.path) !== source.hash) throw new Error('Git effect source must have its SHA-256 content-addressed filename')
  const state = await inspect(root, source.path, MAX_EFFECT_SOURCE_FILE_BYTES, undefined, false)
  if (!state || state.hash !== source.hash || (expectedBytes !== undefined && state.bytes !== expectedBytes)) throw new Error(`Git effect immutable source is missing or changed: ${source.path}`)
  return { hash: state.hash, bytes: state.bytes }
}

export async function copyEffectSource(root: string, source: EffectSource & { bytes: number }, target: FileHandle): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(source.hash) || path.posix.basename(source.path) !== source.hash) throw new Error('Git effect source is not content-addressed')
  const state = await inspect(root, source.path, MAX_EFFECT_SOURCE_FILE_BYTES, async bytes => {
    let offset = 0
    while (offset < bytes.length) {
      const written = await target.write(bytes, offset, bytes.length - offset, null)
      if (!written.bytesWritten) throw new Error('Git effect output could not be written')
      offset += written.bytesWritten
    }
  }, false)
  if (!state || state.hash !== source.hash || state.bytes !== source.bytes) throw new Error(`Git effect immutable source changed while copying: ${source.path}`)
}

// A verified Git receipt depends on committed content, not on a surviving source blob file.
export async function inspectGitEffectBlob(cwd: string, object: string, maxBytes = MAX_EFFECT_SOURCE_FILE_BYTES): Promise<{ hash: string; bytes: number }> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)) throw new Error('Invalid Git blob object id')
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', 'cat-file', 'blob', object], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const digest = createHash('sha256')
    let bytes = 0, stderr = '', failure: Error | null = null
    const timer = setTimeout(() => { failure = new Error('Timed out reading Git effect blob'); child.kill('SIGKILL') }, 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) { failure ??= new Error('Git effect blob exceeds its size limit'); child.kill('SIGKILL'); return }
      digest.update(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', status => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (status !== 0) reject(new Error(`Cannot read Git effect blob: ${stderr.trim()}`))
      else resolve({ hash: digest.digest('hex'), bytes })
    })
  })
}
