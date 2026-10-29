import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { HttpError } from './errors.ts'
import { git, run, ensureExcluded, markedGit } from './git.ts'
import { requireAttemptInactive } from './execution-receipts.ts'
import { parseWorktreeList } from './discovery.ts'
import { withReviewLock } from './review-lock.ts'
import { buildInitialInitiativeStream } from './initiative-events.ts'
import { prepareGitEffect, reconcileGitEffect, type GitEffectInput } from './git-effect.ts'
import { creationBlobRelative, initiativeRelative, CREATION_WORKTREES_EXCLUDE } from './creation-layout.ts'
import type { CreationRequest, CreationState, WorktreeIdentity } from './worktree-events.ts'

export const creationHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export async function worktreeIdentity(cwd: string): Promise<WorktreeIdentity> {
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())
  if (await realpath(cwd) !== root) throw new Error('Creation target must be the canonical worktree root')
  const commonDir = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
  const gitDir = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim())
  const branchResult = await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, allowFailure: true })
  if (branchResult.code !== 0 && branchResult.code !== 1) throw new Error('Cannot inspect creation target branch')
  const registered = parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']))
  if (!registered.some(entry => path.resolve(entry.path) === root)) throw new Error('Creation target is not a registered Git worktree')
  return { root, commonDir, gitDir, branch: branchResult.code === 0 ? branchResult.stdout.trim() : null }
}
export async function withCreationLease<T>(anchor: string, fn: () => Promise<T>): Promise<T> {
  const identity = await worktreeIdentity(anchor)
  return withReviewLock(path.join(identity.commonDir, 'desk-initiative-creation.lease'), fn)
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function writeCreationBlob(cwd: string, hash: string, bytes: Uint8Array): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash) || creationHash(bytes) !== hash || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Invalid captured creation input')
  const root = await realpath(cwd)
  for (const relative of ['.spec-review', '.spec-review/creation-blobs']) {
    const directory = path.join(root, relative)
    await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe creation blob directory')
  }
  const file = path.join(root, creationBlobRelative(hash))
  if (await exists(file)) { await readCreationBlob(cwd, hash); return }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await link(tmp, file).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await readCreationBlob(cwd, hash) })
    const directory = await open(path.dirname(file), 'r'); try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(tmp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
}
export async function readCreationBlob(cwd: string, hash: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid creation blob identity')
  const root = await realpath(cwd), file = path.join(root, creationBlobRelative(hash))
  if (await realpath(path.dirname(file)) !== path.join(root, '.spec-review/creation-blobs')) throw new Error('Unsafe creation blob parent')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 20 * 1024 * 1024) throw new Error('Invalid creation input size or type')
    const bytes = Buffer.alloc(before.size)
    let position = 0
    while (position < bytes.length) { const read = await handle.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) throw new Error('Creation input changed'); position += read.bytesRead }
    const after = await handle.stat()
    if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || creationHash(bytes) !== hash) throw new Error('Captured creation input changed')
    return bytes
  } finally { await handle.close() }
}
const ownerRef = (request: CreationRequest): string => `refs/desk/creation/${request.id}`
const ownership = (request: CreationRequest): string => JSON.stringify({ version: 1, creationId: request.id, requestHash: request.requestHash,
  commonDir: request.anchor.commonDir, targetPath: request.targetPath, branch: request.branch, base: request.base })
async function readRef(cwd: string, ref: string): Promise<string | null> {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, allowFailure: true })
  if (result.code === 1) return null
  if (result.code !== 0) throw new Error(`Cannot inspect creation reference ${ref}`)
  return result.stdout.trim()
}
async function ownedBranch(request: CreationRequest): Promise<{ reserved: boolean; head: string | null }> {
  const marker = await readRef(request.anchor.root, ownerRef(request))
  const head = await readRef(request.anchor.root, request.branch!)
  if (!marker && !head) return { reserved: false, head: null }
  if (!marker || !head || await git(request.anchor.root, ['cat-file', 'blob', marker]) !== ownership(request)) throw new Error('Branch creation ownership cannot be proved')
  return { reserved: true, head }
}
export async function provisionCreationWorktree(request: CreationRequest): Promise<void> {
  await requireAttemptInactive(request.anchor.root, request.id, request.processBoundary)
  if (request.where.kind === 'existing') return
  await ensureExcluded(request.anchor.root, CREATION_WORKTREES_EXCLUDE)
  const branch = await ownedBranch(request)
  if (!branch.reserved) {
    if (await exists(request.targetPath)) throw new Error('Creation target path already exists without ownership proof')
    const object = (await markedGit(request.anchor.root, ['hash-object', '-w', '--stdin'], request.id, ownership(request))).trim()
    await markedGit(request.anchor.root, ['update-ref', '--stdin'], request.id, `start\ncreate ${ownerRef(request)} ${object}\ncreate ${request.branch} ${request.base}\nprepare\ncommit\n`)
  } else if (branch.head !== request.base) throw new Error('Reserved creation branch changed before worktree provisioning')
  if (!await exists(request.targetPath)) {
    await mkdir(path.dirname(request.targetPath), { recursive: true })
    if (await realpath(path.dirname(request.targetPath)) !== path.dirname(request.targetPath)) throw new Error('Creation worktree parent is unsafe')
    await markedGit(request.anchor.root, ['worktree', 'add', '--', request.targetPath, request.branch!.slice('refs/heads/'.length)], request.id)
  }
}
export async function proveCreationWorktree(state: CreationState, allowLaterHead = false): Promise<WorktreeIdentity> {
  const request = state.request
  if (request.where.kind === 'new') {
    const branch = await ownedBranch(request)
    if (!branch.reserved) throw new Error('Creation branch has not been reserved')
    if (!allowLaterHead && branch.head !== request.base) throw new Error('Creation branch changed without a confirmed initial commit')
  }
  const identity = await worktreeIdentity(request.targetPath)
  const bound = state.identity ?? request.existingIdentity
  if (identity.root !== request.targetPath || identity.commonDir !== request.anchor.commonDir || identity.branch !== request.branch ||
    bound && (identity.gitDir !== bound.gitDir || identity.root !== bound.root || identity.commonDir !== bound.commonDir || identity.branch !== bound.branch)) throw new Error('Creation worktree registration changed')
  if (!allowLaterHead && (await git(identity.root, ['rev-parse', 'HEAD'])).trim() !== request.base) throw new Error('Creation target HEAD changed')
  return identity
}
export type CreationObservation = { status: 'completed'; commit: string } | { status: 'not_started' | 'pending' | 'uncertain' | 'failed'; reason: string }
export async function observeInitiativeCreation(state: CreationState): Promise<CreationObservation> {
  try {
    await requireAttemptInactive(state.request.anchor.root, state.request.id, state.request.processBoundary)
    if (state.plan) {
      const receipt = await reconcileGitEffect(state.request.targetPath, state.plan)
      if (receipt.status === 'completed') { await proveCreationWorktree(state, true); return { status: 'completed', commit: receipt.commit } }
      await proveCreationWorktree(state, true)
      return receipt
    }
    if (state.request.where.kind === 'new') {
      const branch = await ownedBranch(state.request)
      if (!branch.reserved) {
        if (await exists(state.request.targetPath)) throw new Error('Unowned creation target exists')
        return { status: 'not_started', reason: 'No branch reservation or target worktree exists' }
      }
      if (!await exists(state.request.targetPath)) return { status: 'pending', reason: 'Owned branch reserved; target worktree has not been created' }
    }
    await proveCreationWorktree(state)
    return { status: 'pending', reason: 'The owned worktree exists; its initial commit has not been requested' }
  } catch (error) { return { status: 'uncertain', reason: error instanceof Error ? error.message : String(error) } }
}
export async function prepareCreationGit(state: CreationState): Promise<Awaited<ReturnType<typeof prepareGitEffect>>> {
  const request = state.request, target = request.targetPath, relative = initiativeRelative(request.name)
  await proveCreationWorktree(state)
  if (await exists(path.join(target, relative))) throw new HttpError(409, 'creation_uncertain', 'The initiative path exists without a recorded creation Git intent')
  const hashes = [...new Set([request.brief, ...request.inputs.map(input => input.blob)])]
  for (const hash of hashes) await writeCreationBlob(target, hash, await readCreationBlob(request.anchor.root, hash))
  const briefBytes = await readCreationBlob(target, request.brief)
  const initial = buildInitialInitiativeStream({ creationId: request.id, streamId: request.streamId, commandId: request.commandId,
    at: request.at, name: request.name, title: request.title, repo: request.repo, brief: request.brief, inputs: request.inputs, existingProcess: request.existingProcess })
  const outputs: GitEffectInput['outputs'][number][] = [
    { path: `${relative}/initiative.events.jsonl`, content: Buffer.from(initial.bytes) },
    { path: `${relative}/initiative.yaml`, content: Buffer.from(stringify(initial.projection, { lineWidth: 0 })) },
    { path: `${relative}/brief.md`, content: briefBytes },
    ...hashes.map(hash => hash === request.brief ? { path: `${relative}/blobs/${hash}`, content: briefBytes } : { path: `${relative}/blobs/${hash}`, source: { path: creationBlobRelative(hash), hash } }),
    ...request.inputs.map(input => ({ path: `${relative}/inputs/${input.file}`, source: { path: creationBlobRelative(input.blob), hash: input.blob } })),
  ]
  return prepareGitEffect(target, { purpose: { kind: 'initiative-creation', ref: request.id }, outputs,
    message: `docs(initiative): ${request.name} - initiative${request.trailer ? `\n\n${request.trailer}` : ''}` })
}
