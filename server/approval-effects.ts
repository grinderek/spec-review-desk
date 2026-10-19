import path from 'node:path'
import { decideApproval, readApprovalFacts } from './approval-commands.ts'
import { approvalSourceIdentity } from './approval-proof.ts'
import type { WorktreeInfo, ChangeRef } from './discovery.ts'
import { assertWorktreeAdmission, withWorktreeAdmission } from './execution-admission.ts'
import { HttpError } from './errors.ts'
import { executeGitEffect, prepareGitEffect, reconcileGitEffect, type GitEffectPlan } from './git-effect.ts'
import { requestReviewEffect, reviewEffectReceipt } from './review-effects.ts'
import { nowIso, readReview, recordReviewEvents, REVIEW_EVENTS_FILE, REVIEW_FILE, withReviewLock } from './review-store.ts'

const command = { type: 'RecordChangeApproval' as const }
const sourceChanged = (): HttpError => new HttpError(409, 'review_source_changed', 'Review source facts changed. Review the current contracts before recording approval.')

async function recordReceipt(ref: ChangeRef, receipt: Awaited<ReturnType<typeof reconcileGitEffect>>): Promise<void> {
  await recordReviewEvents(ref.dir, async doc => ({ events: reviewEffectReceipt(doc, receipt, () => []) }), 'approval-command')
}

// The caller holds the worktree lease and scope lock. This separate command boundary is
// also the crash window between durable owner intent and an external Git operation.
export async function requestChangeApproval(wt: WorktreeInfo, ref: ChangeRef, trailer: string): Promise<GitEffectPlan> {
  const facts = await readApprovalFacts(wt, ref, command)
  let plan!: GitEffectPlan
  await recordReviewEvents(ref.dir, async state => {
    const events = decideApproval(state, command, facts, nowIso())
    const relative = path.relative(wt.path, ref.dir).split(path.sep).join('/')
    plan = await prepareGitEffect(wt.path, { purpose: { kind: 'change-approval', ref: approvalSourceIdentity(facts.sourceVersion) }, outputs: [],
      extraFiles: [`${relative}/${REVIEW_FILE}`, `${relative}/${REVIEW_EVENTS_FILE}`],
      message: `docs(openspec): ${ref.name} - owner approval${trailer ? `\n\n${trailer}` : ''}` })
    return { events: [...events, ...requestReviewEffect(state, plan)], verify: async () => {
      if (JSON.stringify(await readApprovalFacts(wt, ref, command)) !== JSON.stringify(facts)) throw sourceChanged()
    } }
  }, 'approval-command')
  return plan
}

// The approval and its commit intent are one business command. A retry resumes that intent;
// it does not record another owner approval or infer success from the current HEAD alone.
export async function commitChangeApproval(wt: WorktreeInfo, ref: ChangeRef, trailer: string): Promise<{ commit: string }> {
  return withWorktreeAdmission(wt.path, () => withReviewLock(ref.dir, async () => {
    const doc = await readReview(ref.dir)
    const facts = await readApprovalFacts(wt, ref, command)
    const source = approvalSourceIdentity(facts.sourceVersion)
    const previous = doc.git_effects.findLast(effect => effect.plan.purpose.kind === 'change-approval')
    if (previous?.status === 'completed' && previous.plan.purpose.ref === source && previous.commit && facts.readiness?.ready) return { commit: previous.commit }
    let plan: GitEffectPlan | undefined = previous && previous.status !== 'completed' &&
      (previous.plan.purpose.ref === source || previous.status !== 'failed') ? previous.plan : undefined
    await assertWorktreeAdmission(wt.path, { operation: 'git', effectId: plan?.effectId })
    if (plan) {
      const observed = await reconcileGitEffect(wt.path, plan)
      if (observed.status === 'completed') { await recordReceipt(ref, observed); return { commit: observed.commit } }
      if (plan.purpose.ref !== source || !facts.readiness?.ready) throw sourceChanged()
    } else {
      plan = await requestChangeApproval(wt, ref, trailer)
    }
    // Rebuild only the derived view before staging it, including after projection loss.
    await recordReviewEvents(ref.dir, async () => ({ events: [] }), 'approval-command')
    const receipt = await executeGitEffect(wt.path, plan!, { resumePending: true })
    await recordReceipt(ref, receipt)
    if (receipt.status !== 'completed') throw new HttpError(409, `git_effect_${receipt.status}`, receipt.reason)
    return { commit: receipt.commit }
  }))
}

// Startup observes historical proof. It never starts a commit or grants owner approval.
export async function recoverChangeApproval(wt: WorktreeInfo, ref: ChangeRef): Promise<void> {
  await withWorktreeAdmission(wt.path, () => withReviewLock(ref.dir, async () => {
    for (const effect of (await readReview(ref.dir)).git_effects.filter(effect => effect.plan.purpose.kind === 'change-approval' && effect.status !== 'completed')) {
      const receipt = await reconcileGitEffect(wt.path, effect.plan)
      if (receipt.status === 'completed' || receipt.status === 'uncertain' || receipt.status === 'pending') await recordReceipt(ref, receipt)
    }
  }))
}
