import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export class CommandError extends Error {
  constructor(readonly command: string, readonly code: number | null, readonly stderr: string) {
    super(`${command} failed (${code ?? 'no exit code'}): ${stderr.trim().slice(0, 2000)}`)
  }
}

export interface RunResult { stdout: string; stderr: string; code: number | null }
export interface RunOptions { cwd: string; input?: string; timeoutMs?: number; allowFailure?: boolean }

export function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const label = `${cmd} ${args.join(' ')}`
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(new CommandError(label, null, error.message))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0 || opts.allowFailure) resolve({ stdout, stderr, code })
      else reject(new CommandError(label, code, stderr))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(opts.input ?? '')
  })
}

export async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  return (await run('git', args, { cwd, input })).stdout
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function commitFiles(cwd: string, files: readonly string[], message: string): Promise<string> {
  await git(cwd, ['add', '--', ...files])
  await git(cwd, ['commit', '-q', '-F', '-', '--', ...files], message)
  return headSha(cwd)
}

export async function showFile(cwd: string, rev: string, relPath: string): Promise<string | null> {
  const result = await run('git', ['show', `${rev}:${relPath}`], { cwd, allowFailure: true })
  return result.code === 0 ? result.stdout : null
}

export async function findCommitIntroducing(cwd: string, needle: string, relPath: string): Promise<string | null> {
  const result = await run('git', ['log', '-S', needle, '--format=%h', '--reverse', '--', relPath], { cwd, allowFailure: true })
  if (result.code !== 0) return null
  return result.stdout.split('\n')[0]?.trim() || null
}

export async function isDirty(cwd: string, relPath: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--', relPath])).trim() !== ''
}

export async function ensureExcluded(cwd: string, entry = '.spec-review/'): Promise<void> {
  const common = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()
  const file = path.join(path.resolve(cwd, common), 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch {
    current = ''
  }
  if (current.split('\n').some((line) => line.trim() === entry)) return
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`)
  console.log(`spec-review: added ${entry} to ${file}`)
}
