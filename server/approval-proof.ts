import { createHash } from 'node:crypto'
import type { ChangeView } from './change-view.ts'

export function approvalSourceVersion(view: ChangeView): string {
  return JSON.stringify({
    scenarios: view.features.flatMap(feature => feature.scenarios).map(({ key, hash }) => ({ key, hash })),
    phrases: view.phrases.map(({ key, hash }) => ({ key, hash })), joinKey: view.joinKey, errors: view.errors,
  })
}
export const approvalSourceIdentity = (source: string | undefined): string => createHash('sha256').update(source ?? '').digest('hex')

// Owner intent authorizes the commit. Only the latest approval effect for the current
// source version proves that the required Git completion was actually accepted.
export function approvalCommitProven(view: ChangeView): boolean {
  const effect = view.review.git_effects.findLast(effect => effect.plan.purpose.kind === 'change-approval')
  return Boolean(view.review.approved_at && effect?.status === 'completed' && effect.commit &&
    effect.plan.purpose.ref === approvalSourceIdentity(approvalSourceVersion(view)))
}
