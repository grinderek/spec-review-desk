import { createHash } from 'node:crypto'
import type { ChangeView } from './change-view.ts'

type ApprovalSource = Pick<ChangeView, 'contracts' | 'phrases' | 'metadata' | 'validation'>
export function approvalSourceVersion(view: ApprovalSource): string {
  return JSON.stringify({
    contracts: view.contracts.map(({ key, hash, sourceHash }) => ({ key, hash, sourceHash })).sort((a, b) => a.key.localeCompare(b.key, 'en')),
    phrases: view.phrases.map(({ key, hash }) => ({ key, hash })).sort((a, b) => a.key.localeCompare(b.key, 'en')),
    metadata: view.metadata, validation: view.validation,
  })
}
export const approvalSourceIdentity = (source: string | undefined): string => createHash('sha256').update(source ?? '').digest('hex')

// Owner intent authorizes the commit. Only the latest approval effect for the current
// source version proves that the required Git completion was actually accepted.
export function approvalCommitProven(view: ApprovalSource & Pick<ChangeView, 'review'>): boolean {
  const effect = view.review.git_effects.findLast(effect => effect.plan.purpose.kind === 'change-approval')
  return Boolean(view.review.approved_at && effect?.status === 'completed' && effect.commit &&
    effect.plan.purpose.ref === approvalSourceIdentity(approvalSourceVersion(view)))
}
