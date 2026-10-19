import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { withReviewLock } from './review-lock.ts'

// Facts belong to the caller's scope stream. This module only prepares and executes a
// recorded intent; replay and reconciliation never write files or create commits.
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const safePath = (value: string): boolean => value.length > 0 && !/[\\\0\r\n]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
const RelativePathSchema = z.string().max(4096).refine(safePath, 'must be a relative regular-file path outside .git')
const FullShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
// These are the two regular-file modes Git can preserve in a receipt. Special files,
// special permission bits and permissions Git cannot prove are deliberately unsupported.
const ModeSchema = z.union([z.literal(0o644), z.literal(0o755)])
export const GitEffectFileStateSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), mode: ModeSchema })
export const GitEffectFileSchema = z.object({
  path: RelativePathSchema,
  before: GitEffectFileStateSchema.nullable(),
  after: GitEffectFileStateSchema.extend({ content: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4) }).nullable(),
})
export const GitEffectPlanSchema = z.object({
  version: z.literal(1),
  effectId: z.uuid(),
  purpose: z.object({ kind: z.string().min(1).max(100), ref: z.string().min(1).max(500) }),
  expectedHead: FullShaSchema,
  files: z.array(GitEffectFileSchema).max(100),
  // Names are recorded before execution. The scope journal cannot hash itself in its intent.
  extraFiles: z.array(RelativePathSchema).max(100),
  message: z.string().trim().min(1).max(20_000).refine(value => !/^Desk-Effect:/im.test(value), 'Desk-Effect is reserved'),
}).superRefine((plan, ctx) => {
  if (!plan.files.length && !plan.extraFiles.length) ctx.addIssue({ code: 'custom', message: 'A Git effect needs an output or an explicit journal file' })
  const paths = new Set<string>()
  if (new Set(plan.extraFiles).size !== plan.extraFiles.length) {
    ctx.addIssue({ code: 'custom', path: ['extraFiles'], message: 'duplicate extra file path' })
  }
  let total = 0
  for (const [i, file] of plan.files.entries()) {
    if (paths.has(file.path)) ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'duplicate output path' })
    if (plan.files.some(other => other !== file && (other.path.startsWith(`${file.path}/`) || file.path.startsWith(`${other.path}/`)))) {
      ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'output paths may not contain other outputs' })
    }
    paths.add(file.path)
    if (!file.after) continue
    const bytes = Buffer.from(file.after.content, 'base64')
    total += bytes.length
    if (bytes.toString('base64') !== file.after.content || bytes.length > MAX_FILE_BYTES || sha256(bytes) !== file.after.hash) {
      ctx.addIssue({ code: 'custom', path: ['files', i, 'after'], message: 'invalid inline content or content hash' })
    }
  }
  if (total > MAX_TOTAL_BYTES) ctx.addIssue({ code: 'custom', path: ['files'], message: 'outputs exceed 16 MiB' })
})

export type GitEffectFileState = z.infer<typeof GitEffectFileStateSchema>
export type GitEffectPlan = z.infer<typeof GitEffectPlanSchema>
export interface GitEffectInput {
  purpose: GitEffectPlan['purpose']
  outputs: readonly { path: string; content: Buffer | null; mode?: number }[]
  extraFiles?: readonly string[]
  message: string
}
export interface GitEffectOptions {
  // Include the caller's journal/projections, but never hash the journal into its own intent.
  extraFiles?: readonly string[]
  // Only an explicit owner retry may finish a known partial application. Recovery omits this.
  resumePending?: boolean
}
export type GitEffectReceipt =
  | { status: 'completed'; effectId: string; commit: string }
  | { status: 'not_started' | 'pending' | 'uncertain' | 'failed'; effectId: string; reason: string }

interface GitResult { stdout: Buffer; stderr: string; code: number | null }
function git(cwd: string, args: readonly string[], allowFailure = false): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'buffer', maxBuffer: MAX_TOTAL_BYTES * 2, timeout: 60_000 }, (error, stdout, stderr) => {
      const result = { stdout, stderr: stderr.toString('utf8'), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 }
      if (error && !allowFailure) reject(new Error(`Git effect command failed: ${result.stderr.trim() || error.message}`))
      else resolve(result)
    })
  })
}
async function rootOf(cwd: string): Promise<string> {
  const root = await realpath(cwd)
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.toString('utf8').trimEnd()
  if (await realpath(top) !== root) throw new Error('Git effects require the worktree root as cwd')
  return root
}
const head = async (cwd: string): Promise<string> => FullShaSchema.parse((await git(cwd, ['rev-parse', '--verify', 'HEAD'])).stdout.toString('utf8').trim())

// The lock key is stable across processes; the actual flock file is managed outside the repo.
// Callers take this lease before their scope lock, and retain both through completion recording.
export async function withGitEffectLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = await rootOf(cwd)
  const key = path.join(root, '.desk-git-effect-lease')
  try { if ((await lstat(key)).isSymbolicLink()) throw new Error('Git effect lease path may not be a symlink') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return withReviewLock(key, fn)
}

async function checkedFile(root: string, relative: string): Promise<string> {
  RelativePathSchema.parse(relative)
  let current = root
  const parts = relative.split('/')
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new Error(`Git effect path is not a regular file with directory parents: ${relative}`)
      }
      if (i < parts.length - 1) {
        try { await lstat(path.join(current, '.git')); throw new Error(`Git effect path crosses a nested repository: ${relative}`) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return current
}
async function fileState(root: string, relative: string): Promise<GitEffectFileState | null> {
  const file = await checkedFile(root, relative)
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES || (info.mode & 0o7000)) throw new Error(`Unsupported Git effect file: ${relative}`)
      const content = await handle.readFile()
      if (content.length > MAX_FILE_BYTES) throw new Error(`Git effect file exceeds 4 MiB: ${relative}`)
      return { hash: sha256(content), mode: ModeSchema.parse(info.mode & 0o777) }
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
const same = (a: GitEffectFileState | null, b: GitEffectFileState | null): boolean => a === null || b === null
  ? a === b : a.hash === b.hash && a.mode === b.mode
const gitMode = (mode: number): string => mode & 0o111 ? '100755' : '100644'
const messageFor = (plan: GitEffectPlan): string => `${plan.message.trimEnd()}\n\nDesk-Effect: ${plan.effectId}\n`

export async function prepareGitEffect(cwd: string, input: GitEffectInput): Promise<GitEffectPlan> {
  const root = await rootOf(cwd)
  const expectedHead = await head(root)
  const files: GitEffectPlan['files'] = []
  for (const output of input.outputs) {
    const before = await fileState(root, output.path)
    const mode = ModeSchema.parse(output.mode ?? before?.mode ?? 0o644)
    files.push({ path: output.path, before, after: output.content === null ? null : {
      hash: sha256(output.content), mode, content: output.content.toString('base64'),
    } })
  }
  if (await head(root) !== expectedHead) throw new Error('Git HEAD changed while preparing the effect')
  return GitEffectPlanSchema.parse({ version: 1, effectId: randomUUID(), purpose: input.purpose, expectedHead, files,
    extraFiles: [...new Set(input.extraFiles ?? [])].sort(), message: input.message })
}

async function verifyCommit(root: string, plan: GitEffectPlan, commit: string): Promise<boolean> {
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', commit])).stdout.toString('utf8').trim().split(' ')
  if (parents.length !== 2 || parents[1] !== plan.expectedHead) return false
  const message = (await git(root, ['show', '-s', '--format=%B', commit])).stdout.toString('utf8')
  if (message.trimEnd() !== messageFor(plan).trimEnd()) return false
  // Additional scope journal/view paths are intentionally not content-hashed in the intent,
  // but a receipt must not hide a symlink, submodule or unsafe path in those committed files.
  const allowed = new Set([...plan.files.map(file => file.path), ...plan.extraFiles])
  const changed = (await git(root, ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', plan.expectedHead, commit])).stdout.toString('utf8').split('\0').filter(Boolean)
  for (const relative of changed) {
    if (!safePath(relative) || !allowed.has(relative)) return false
    const entry = (await git(root, ['ls-tree', '-z', commit, '--', relative])).stdout.toString('utf8')
    if (entry && !/^(100644|100755) blob [0-9a-f]+\t[^\0]+\0$/.test(entry)) return false
  }
  for (const file of plan.files) {
    const entry = (await git(root, ['ls-tree', '-z', commit, '--', file.path])).stdout.toString('utf8')
    if (!file.after) { if (entry) return false; continue }
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry)
    if (!match || match[1] !== gitMode(file.after.mode) || match[3] !== file.path) return false
    const content = (await git(root, ['cat-file', 'blob', match[2]!])).stdout
    if (sha256(content) !== file.after.hash) return false
  }
  return true
}

// Observation only. A matching commit is historical proof even if later commits changed files.
// Unknown external changes and missing evidence never become an automatic retry.
export async function reconcileGitEffect(cwd: string, rawPlan: GitEffectPlan): Promise<GitEffectReceipt> {
  const plan = GitEffectPlanSchema.parse(rawPlan)
  try {
    const root = await rootOf(cwd)
    const result = await git(root, ['log', '--all', '--reflog', '--format=%H', '--fixed-strings', `--grep=Desk-Effect: ${plan.effectId}`])
    const candidates = [...new Set(result.stdout.toString('utf8').trim().split('\n').filter(Boolean))]
    const exact: string[] = []
    for (const commit of candidates) {
      const body = (await git(root, ['show', '-s', '--format=%B', commit])).stdout.toString('utf8')
      if (body.split('\n').some(line => line === `Desk-Effect: ${plan.effectId}`)) exact.push(commit)
    }
    if (exact.length) {
      if (exact.length === 1 && await verifyCommit(root, plan, exact[0]!)) return { status: 'completed', effectId: plan.effectId, commit: exact[0]! }
      return { status: 'uncertain', effectId: plan.effectId, reason: 'Effect commits are duplicated or do not match the planned parent, message and files' }
    }
    if (await head(root) !== plan.expectedHead) return { status: 'uncertain', effectId: plan.effectId, reason: 'HEAD changed without a verified effect commit' }
    const states = await Promise.all(plan.files.map(file => fileState(root, file.path)))
    if (states.every((state, i) => same(state, plan.files[i]!.before))) return { status: 'not_started', effectId: plan.effectId, reason: 'No effect commit exists and outputs match their original state' }
    if (states.every((state, i) => same(state, plan.files[i]!.before) || same(state, plan.files[i]!.after))) {
      return { status: 'pending', effectId: plan.effectId, reason: 'Some or all planned files are materialized, but no effect commit is confirmed' }
    }
    return { status: 'uncertain', effectId: plan.effectId, reason: 'Files differ from both their planned original and resulting state' }
  } catch (error) {
    return { status: 'uncertain', effectId: plan.effectId, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function materialize(root: string, file: GitEffectPlan['files'][number]): Promise<void> {
  const target = await checkedFile(root, file.path)
  if (!same(await fileState(root, file.path), file.before)) throw new Error(`Git effect input changed: ${file.path}`)
  if (!file.after) { if (file.before) await unlink(target); return }
  await mkdir(path.dirname(target), { recursive: true })
  await checkedFile(root, file.path)
  const tmp = `${target}.desk-effect-${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.after.mode)
    created = true
    try {
      await handle.writeFile(Buffer.from(file.after.content, 'base64'))
      await handle.chmod(file.after.mode)
      await handle.sync()
    } finally { await handle.close() }
    if (!same(await fileState(root, file.path), file.before)) throw new Error(`Git effect input changed before replacement: ${file.path}`)
    await rename(tmp, target)
  } finally { if (created) await unlink(tmp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
}

// Caller has persisted the intent and holds the worktree lease, then the scope lease.
// A partial application needs explicit resumePending; reconciliation never requests that.
// This never rolls files back blindly or repeats an already verified commit.
export async function executeGitEffect(cwd: string, rawPlan: GitEffectPlan, options: GitEffectOptions = {}): Promise<GitEffectReceipt> {
  const plan = GitEffectPlanSchema.parse(rawPlan)
  const extras = [...plan.extraFiles].sort()
  if (options.extraFiles !== undefined) {
    const provided = [...new Set(options.extraFiles)].sort()
    if (provided.length !== extras.length || provided.some((file, index) => file !== extras[index])) {
      throw new Error('Git effect extra files must match the recorded plan')
    }
  }
  const initial = await reconcileGitEffect(cwd, plan)
  const resuming = initial.status === 'pending' && options.resumePending === true
  if (initial.status !== 'not_started' && !resuming) return initial
  try {
    const root = await rootOf(cwd)
    for (const extra of extras) {
      if (!await fileState(root, extra)) throw new Error(`Git effect extra file is missing: ${extra}`)
    }
    if (await head(root) !== plan.expectedHead) throw new Error('HEAD changed before Git effect execution')
    for (const file of plan.files) {
      const state = await fileState(root, file.path)
      if (!same(state, file.before) && !(resuming && same(state, file.after))) throw new Error(`Git effect input changed: ${file.path}`)
    }
    for (const file of plan.files) {
      if (!resuming || !same(await fileState(root, file.path), file.after)) await materialize(root, file)
    }
    if (await head(root) !== plan.expectedHead) throw new Error('HEAD changed while materializing Git effect outputs')
    for (const file of plan.files) {
      if (!same(await fileState(root, file.path), file.after)) throw new Error(`Git effect output changed: ${file.path}`)
    }
    for (const extra of extras) {
      if (!await fileState(root, extra)) throw new Error(`Git effect extra file disappeared: ${extra}`)
    }
    const files = [...new Set([...plan.files.filter(file => file.before || file.after).map(file => file.path), ...extras])]
    if (!files.length) throw new Error('Git effect has no files to commit')
    await git(root, ['add', '--all', '--', ...files])
    await git(root, ['commit', '--only', '--cleanup=verbatim', '-q', '-m', messageFor(plan), '--', ...files])
    return await reconcileGitEffect(root, plan)
  } catch (error) {
    const receipt = await reconcileGitEffect(cwd, plan)
    if (receipt.status !== 'not_started') return receipt
    return { status: 'failed', effectId: plan.effectId, reason: error instanceof Error ? error.message : String(error) }
  }
}
