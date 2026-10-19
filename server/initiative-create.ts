import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './config.ts'
import { discover, listWorktrees, type Registry, worktreeId } from './discovery.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { HttpError } from './errors.ts'
import { captureExecutionBoundary } from './execution-receipts.ts'
import { ensureExcluded, git, run } from './git.ts'
import { executeGitEffect } from './git-effect.ts'
import { briefText } from './initiative-brief.ts'
import { isInitiativeName } from './initiative-store.ts'
import { type IncomingFile, planInputs, readRepoFile } from './inputs.ts'
import { withReviewLock } from './review-lock.ts'
import { creationHash, observeInitiativeCreation, prepareCreationGit, proveCreationWorktree, provisionCreationWorktree, withCreationLease, worktreeIdentity, writeCreationBlob } from './worktree-creation.ts'
import { creationRequestHash, readWorktreeStream, recordWorktreeEvents, type CreationRequest, type CreationState } from './worktree-events.ts'
import { initiativeRelative, worktreeRel } from './creation-layout.ts'
export { worktreeRel } from './creation-layout.ts'
export { observeInitiativeCreation } from './worktree-creation.ts'

export type Where = { kind: 'new'; base: string } | { kind: 'existing'; worktreeId: string }
export interface CreateInput { name: string; repo: string; where: Where; title: string; brief: string; files: IncomingFile[]; fromRepo: string[]; requestId?: string }
export function createCommands(input: Pick<CreateInput, 'name' | 'where'>, repoPath: string): string[][] {
  if (input.where.kind !== 'new') return []
  return [['git', '-C', repoPath, 'worktree', 'add', worktreeRel(input.name), '-b', `plan/${input.name}`, input.where.base]]
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
async function pathExists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function configuredRepo(config: Config, name: string) {
  const repo = config.repos.find(repo => repo.name === name)
  if (!repo) throw new HttpError(404, 'unknown_repo', `No configured repo ${name}`)
  return repo
}
async function creationState(anchor: string, id: string): Promise<CreationState> {
  const state = (await readWorktreeStream(anchor)).creations.find(state => state.request.id === id)
  if (!state) throw new HttpError(404, 'unknown_creation', 'No recorded initiative creation request')
  return state
}
async function observeRecorded(anchor: string, id: string): Promise<Awaited<ReturnType<typeof observeInitiativeCreation>>> {
  const state = await creationState(anchor, id), observed = await observeInitiativeCreation(state)
  await recordWorktreeEvents(anchor, states => {
    const current = states.find(state => state.request.id === id)!
    if (current.status === 'completed') return []
    if (observed.status === 'completed') return [{ type: 'InitiativeCreationCompleted', creationId: id, commit: observed.commit }]
    return current.status === observed.status && current.reason === observed.reason ? [] : [{ type: 'InitiativeCreationObserved', creationId: id, status: observed.status, reason: observed.reason }]
  })
  return observed
}

// Capture owner intent before creating any branch, worktree or business file.
export async function requestInitiativeCreation(config: Config, input: CreateInput, at: string): Promise<CreationState> {
  if (!isInitiativeName(input.name)) throw new HttpError(422, 'invalid_name', 'The name is a slug: a-z, 0-9 and -, 2 to 41 characters')
  const repo = configuredRepo(config, input.repo), anchor = await worktreeIdentity(repo.path)
  const copies = await Promise.all(input.fromRepo.map(file => readRepoFile([config.hubRoot, ...config.repos.map(repo => repo.path)], config.hubRoot, file)))
  const planned = planInputs({ inputs: [] }, [...input.files, ...copies])
  const briefBytes = Buffer.from(briefText(input.brief)), brief = creationHash(briefBytes)
  const inputs = planned.map(({ name, file }) => ({ file: name, bytes: file.bytes.byteLength, blob: creationHash(file.bytes), source: file.source, added_at: at, draft: false }))
  const requestHash = creationRequestHash({ name: input.name, repo: input.repo, title: input.title, where: input.where, brief,
    inputs: inputs.map(({ added_at, ...entry }) => entry) })
  if (planned.length + new Set([brief, ...inputs.map(input => input.blob)]).size + 3 > 1000) throw new HttpError(413, 'inputs_too_many', 'The initiative has too many separate input files')
  return withCreationLease(anchor.root, async () => {
    const previous = (await readWorktreeStream(anchor.root)).creations.find(state => state.request.name === input.name || state.request.id === input.requestId)
    if (previous) {
      if (previous.request.requestHash !== requestHash || input.requestId && previous.request.id !== input.requestId) throw new HttpError(409, 'creation_request_changed', 'This initiative name already has a different recorded creation request')
      return previous
    }
    const worktrees = await listWorktrees({ ...repo, path: anchor.root })
    for (const wt of worktrees) if (await pathExists(path.join(wt.path, initiativeRelative(input.name)))) throw new HttpError(409, 'name_taken', `An initiative ${input.name} already exists`)
    let targetPath: string, branch: string | null, base: string, existingIdentity: CreationRequest['existingIdentity'] = null
    if (input.where.kind === 'existing') {
      const selected = input.where.worktreeId
      const target = worktrees.find(wt => wt.id === selected)
      if (!target) throw new HttpError(404, 'unknown_worktree', 'The selected worktree is not registered in this repository')
      existingIdentity = await worktreeIdentity(target.path); targetPath = existingIdentity.root; branch = existingIdentity.branch
      base = (await git(targetPath, ['rev-parse', 'HEAD'])).trim()
    } else {
      targetPath = path.join(anchor.root, worktreeRel(input.name)); branch = `refs/heads/plan/${input.name}`
      const found = await run('git', ['show-ref', '--verify', '--quiet', branch], { cwd: anchor.root, allowFailure: true })
      if (found.code === 0 || await pathExists(targetPath)) throw new HttpError(409, 'name_taken', 'The requested branch or worktree path already exists')
      if (found.code !== 1) throw new Error('Cannot inspect the requested creation branch')
      const resolved = await run('git', ['rev-parse', '--verify', '--quiet', `${input.where.base}^{commit}`], { cwd: anchor.root, allowFailure: true })
      if (resolved.code !== 0) throw new HttpError(422, 'unknown_base', `No branch or commit ${input.where.base}`)
      base = resolved.stdout.trim()
    }
    await writeCreationBlob(anchor.root, brief, briefBytes)
    for (let index = 0; index < planned.length; index++) await writeCreationBlob(anchor.root, inputs[index]!.blob, planned[index]!.file.bytes)
    const request: CreationRequest = { id: input.requestId ?? randomUUID(), requestHash, name: input.name, title: input.title, repo: input.repo, at,
      processBoundary: await captureExecutionBoundary(),
      anchor, targetPath, base, branch, where: input.where, existingIdentity, streamId: randomUUID(), commandId: randomUUID(), brief, inputs, trailer: config.commitTrailer }
    await recordWorktreeEvents(anchor.root, () => [{ type: 'InitiativeCreationRequested', request }])
    return creationState(anchor.root, request.id)
  })
}

// Only explicit create/retry commands execute effects. Recovery merely accepts proof.
export async function executeInitiativeCreation(config: Config, repoName: string, id: string): Promise<{ worktreeId: string; name: string }> {
  const anchor = (await worktreeIdentity(configuredRepo(config, repoName).path)).root
  return withCreationLease(anchor, async () => {
    let state = await creationState(anchor, id)
    const result = { worktreeId: worktreeId(state.request.targetPath), name: state.request.name }
    if (state.status === 'completed') return result
    if (!isDeepStrictEqual(await worktreeIdentity(anchor), state.request.anchor)) throw new HttpError(409, 'creation_uncertain', 'The creation anchor registration changed')
    const observed = await observeInitiativeCreation(state)
    if (observed.status === 'completed') { await observeRecorded(anchor, id); return result }
    if (observed.status === 'uncertain') { await observeRecorded(anchor, id); throw new HttpError(409, 'creation_uncertain', observed.reason) }
    try {
      if (!state.plan) await provisionCreationWorktree(state.request)
      await proveCreationWorktree(state)
      await withWorktreeAdmission(state.request.targetPath, async () => {
        await assertWorktreeAdmission(state.request.targetPath, { operation: 'git', effectId: state.plan?.effectId, creationId: id })
        await withReviewLock(path.join(state.request.targetPath, `.desk-initiative-${state.request.name}.scope`), async () => {
          await ensureExcluded(state.request.targetPath)
          if (!state.identity) {
            const identity = await proveCreationWorktree(state)
            await recordWorktreeEvents(anchor, () => [{ type: 'InitiativeWorktreeConfirmed', creationId: id, identity }])
            state = await creationState(anchor, id)
          }
          if (!state.plan) {
            const plan = await prepareCreationGit(state)
            await recordWorktreeEvents(anchor, () => [{ type: 'InitiativeCreationGitRequested', creationId: id, plan }])
            state = await creationState(anchor, id)
          }
          const receipt = await executeGitEffect(state.request.targetPath, state.plan!, { resumePending: true })
          await recordWorktreeEvents(anchor, () => receipt.status === 'completed' ? [{ type: 'InitiativeCreationCompleted', creationId: id, commit: receipt.commit }] :
            [{ type: 'InitiativeCreationObserved', creationId: id, status: receipt.status, reason: receipt.reason }])
          if (receipt.status !== 'completed') throw new HttpError(409, `creation_${receipt.status}`, receipt.reason)
        })
      })
    } catch (error) {
      if (error instanceof HttpError) throw error
      await observeRecorded(anchor, id)
      throw new HttpError(409, 'creation_uncertain', errorText(error))
    }
    return result
  })
}
export async function recoverInitiativeCreations(config: Config, repoName: string): Promise<void> {
  const anchor = (await worktreeIdentity(configuredRepo(config, repoName).path)).root
  await withCreationLease(anchor, async () => {
    for (const state of (await readWorktreeStream(anchor)).creations.filter(state => state.status !== 'completed')) await observeRecorded(anchor, state.request.id)
  })
}
export async function createInitiative(config: Config, registry: Registry, input: CreateInput, at: string): Promise<{ worktreeId: string; name: string }> {
  const state = await requestInitiativeCreation(config, input, at)
  const result = await executeInitiativeCreation(config, input.repo, state.request.id)
  await discover(config.repos, registry)
  return result
}
