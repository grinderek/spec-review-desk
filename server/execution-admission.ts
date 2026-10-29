import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { listChanges, parseWorktreeList, type WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { executionBusy, type ExecutionRun } from './execution-model.ts'
import { withGitEffectLock } from './git-effect.ts'
import { INITIATIVE_FILE, INITIATIVE_NAME } from './initiative-model.ts'
import { projectInitiative, readInitiativeStream } from './initiative-events.ts'
import { readReview } from './review-store.ts'
import { readVerificationStream } from './verification-events.ts'
import { readWorktreeStream } from './worktree-events.ts'
import { git } from './git.ts'
import { INITIATIVE_ROOT } from './change-package.ts'
import { nativeScopeDirectories } from './native-path.ts'
import { requireAttemptInactive } from './execution-receipts.ts'
import { z } from 'zod'

export interface WorktreeAdmission {
  operation: 'reviewer' | 'apply' | 'verification' | 'initiative' | 'git'
  runId?: string
  effectId?: string
  creationId?: string
}

// Always acquire this lease before any command's scope lock. The scan below only reads
// streams and pure projections; it never acquires another scope lock or launches recovery.
export const withWorktreeAdmission = withGitEffectLock

export async function assertWorktreeAdmission(cwd: string, request: WorktreeAdmission): Promise<void> {
  const canonical = await realpath(cwd)
  // Links only locate the authoritative review journal. They never declare a run active
  // or completed themselves, and a lost journal cannot silently release its components.
  const links = path.join(canonical, '.spec-review/apply-links')
  const linked = await readdir(links).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })
  for (const name of linked) {
    if (!name.endsWith('.json')) continue
    const file = path.join(links, name)
    const info = await lstat(file)
    if (!info.isFile() || info.size > 16_000) throw new HttpError(409, 'apply_scope_uncertain', 'An Apply workspace link cannot be read safely')
    const link = z.object({ anchor: z.string(), reviewDir: z.string(), runId: z.uuid() }).parse(JSON.parse(await readFile(file, 'utf8')))
    if (name !== `${link.runId}.json`) throw new HttpError(409, 'apply_scope_uncertain', 'Apply workspace link identity mismatch')
    if (link.runId === request.runId) continue
    const run = (await readReview(link.reviewDir)).executions.find(run => run.request.id === link.runId)
    const attempt = run?.attempts.at(-1)
    if (!run || run.request.role !== 'apply' || attempt?.spec.kind !== 'agent'
      || !attempt.spec.workspaceRoots?.some(root => root.path === canonical)) {
      throw new HttpError(409, 'apply_scope_uncertain', 'The review journal cannot confirm this component reservation')
    }
    if (executionBusy(run)) throw new HttpError(409, 'apply_running', 'An Apply execution uses this component or requires recovery')
    try { await requireAttemptInactive(link.anchor, attempt.id, attempt.processBoundary) }
    catch { throw new HttpError(409, 'apply_scope_uncertain', 'A previous Apply process still owns this component') }
  }
  for (const wt of parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']))) {
    for (const creation of (await readWorktreeStream(wt.path)).creations) {
      if (creation.request.id !== request.creationId && creation.request.targetPath === canonical && creation.status !== 'completed') {
        throw new HttpError(409, 'creation_pending', 'Finish or recover the recorded initiative creation before more work starts')
      }
    }
  }
  const wt: WorktreeInfo = { path: cwd, id: '', repo: '', branch: null, head: '' }
  const runs: ExecutionRun[] = []
  const effects: string[] = []
  const scopes = (await listChanges(wt)).map(ref => ref.dir)
  const root = path.join(cwd, INITIATIVE_ROOT)
  const initiatives = await nativeScopeDirectories(root, name => INITIATIVE_NAME.test(name))
  for (const name of initiatives) {
    const dir = path.join(root, name)
    const stream = await readInitiativeStream(dir)
    if (!stream.events.length) {
      const snapshot = await lstat(path.join(dir, INITIATIVE_FILE)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (snapshot) throw new HttpError(409, 'initiative_history_missing', 'Initiative journal is required; snapshot import is unsupported')
      continue
    }
    scopes.push(dir)
    runs.push(...projectInitiative(stream.events).executions)
    for (const { event } of stream.events) {
      if (event.type === 'InitiativeRunGitRequested' && !stream.events.some(({ event: later }) =>
        later.type === 'InitiativeRunGitCompleted' && later.effectId === event.plan.effectId)) effects.push(event.plan.effectId)
      if (event.type === 'InitiativeOwnerGitRequested' && !stream.events.some(({ event: later }) =>
        later.type === 'InitiativeOwnerGitCompleted' && later.effectId === event.plan.effectId)) effects.push(event.plan.effectId)
    }
  }
  for (const dir of scopes) {
    const doc = await readReview(dir)
    runs.push(...doc.executions)
    effects.push(...doc.git_effects.filter(effect => ['requested', 'pending', 'uncertain'].includes(effect.status)).map(effect => effect.plan.effectId))
  }
  const verification = (await readVerificationStream(cwd)).projection
  if (verification.rerun && !(request.operation === 'verification' && request.runId === verification.rerun.afterRunId)) {
    throw new HttpError(409, 'verification_queued', 'A saved verification request must run or be cancelled before more work starts')
  }
  const cleanupPending = Object.values(verification.cleanups).some(intent => intent.status !== 'completed')
  const cleanupMissing = verification.runs.some(run => {
    const attempt = run.attempts.at(-1)
    return attempt && (!executionBusy(run) || verification.abandoned.includes(run.request.id)) && verification.containers[attempt.id]?.id && !verification.cleanups[attempt.id]
  })
  if (cleanupPending || cleanupMissing) throw new HttpError(409, 'verification_cleanup_pending', 'Verification container cleanup must finish before more work starts')
  runs.push(...verification.runs.filter(run => !verification.abandoned.includes(run.request.id)))
  const other = runs.filter(run => run.request.id !== request.runId && executionBusy(run))
  if (other.some(run => run.request.role === 'apply')) {
    throw new HttpError(409, 'apply_running', 'An Apply execution is active or requires recovery in this worktree')
  }
  if (effects.some(id => id !== request.effectId)) {
    throw new HttpError(409, 'git_effect_pending', 'A Git operation requires recovery or an explicit retry before more work starts')
  }
  const exclusive = request.operation === 'apply' || request.operation === 'verification'
  if (other.some(run => exclusive || run.request.role === 'verification' || run.outcome === 'uncertain')) {
    throw new HttpError(409, 'execution_pending', 'Finish or recover conflicting work before starting this operation')
  }
}
