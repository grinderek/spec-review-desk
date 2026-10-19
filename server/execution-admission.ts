import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { listChanges, type WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { executionBusy, type ExecutionRun } from './execution-model.ts'
import { withGitEffectLock } from './git-effect.ts'
import { INITIATIVE_NAME } from './initiative-model.ts'
import { projectInitiative, readInitiativeStream } from './initiative-events.ts'
import { readReview } from './review-store.ts'
import { readVerificationStream } from './verification-events.ts'

export interface WorktreeAdmission {
  operation: 'reviewer' | 'apply' | 'verification' | 'initiative' | 'git'
  runId?: string
  effectId?: string
}

// Always acquire this lease before any command's scope lock. The scan below only reads
// streams and pure projections; it never acquires another scope lock or launches recovery.
export const withWorktreeAdmission = withGitEffectLock

export async function assertWorktreeAdmission(cwd: string, request: WorktreeAdmission): Promise<void> {
  const wt: WorktreeInfo = { path: cwd, id: '', repo: '', branch: null, head: '' }
  const runs: ExecutionRun[] = []
  const effects: string[] = []
  const scopes = (await listChanges(wt)).map(ref => ref.dir)
  const root = path.join(cwd, 'openspec', 'initiatives')
  const initiatives = await readdir(root, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of initiatives) {
    if (!entry.isDirectory() || !INITIATIVE_NAME.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    const stream = await readInitiativeStream(dir)
    if (!stream.events.length) continue
    scopes.push(dir)
    runs.push(...projectInitiative(stream.events).executions)
    for (const { event } of stream.events) {
      if (event.type === 'InitiativeRunGitRequested' && !stream.events.some(({ event: later }) =>
        later.type === 'InitiativeRunGitCompleted' && later.effectId === event.plan.effectId)) effects.push(event.plan.effectId)
    }
  }
  for (const dir of scopes) {
    const doc = await readReview(dir)
    runs.push(...doc.executions)
    effects.push(...doc.git_effects.filter(effect => ['requested', 'pending', 'uncertain'].includes(effect.status)).map(effect => effect.plan.effectId))
  }
  const verification = (await readVerificationStream(cwd)).projection
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
