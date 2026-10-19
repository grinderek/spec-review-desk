import { HttpError } from './errors.ts'
import type { GitEffectPlan, GitEffectReceipt } from './git-effect.ts'
import type { ReviewDoc, ReviewDomainEvent } from './review-store.ts'

export type ReviewEffectEvent =
  | { type: 'GitEffectRequested'; effect: GitEffectPlan }
  | { type: 'GitEffectCompleted'; effectId: string; commit: string }
  | { type: 'GitEffectFailed' | 'GitEffectPending' | 'GitEffectUncertain'; effectId: string; reason: string }

export function requestReviewEffect(doc: ReviewDoc, effect: GitEffectPlan): ReviewEffectEvent[] {
  if (doc.git_effects.some(e => e.plan.effectId === effect.effectId)) throw new HttpError(409, 'effect_exists', 'This Git effect was already requested')
  assertReviewEffectsSettled(doc)
  return [{ type: 'GitEffectRequested', effect }]
}

export function assertReviewEffectsSettled(doc: ReviewDoc, except?: string): void {
  if (doc.git_effects.some(e => e.plan.effectId !== except && ['requested', 'pending', 'uncertain'].includes(e.status))) {
    throw new HttpError(409, 'git_effect_pending', 'A Git operation requires recovery or an explicit retry before another write')
  }
}

export function reviewEffectReceipt(doc: ReviewDoc, receipt: GitEffectReceipt,
  complete: (doc: ReviewDoc, commit: string) => ReviewDomainEvent[]): ReviewDomainEvent[] {
  const record = doc.git_effects.find(e => e.plan.effectId === receipt.effectId)
  if (!record) throw new Error(`Unknown Git effect ${receipt.effectId}`)
  if (record.status === 'completed') {
    if (receipt.status !== 'completed' || receipt.commit !== record.commit) throw new Error('Conflicting Git effect completion')
    return []
  }
  if (receipt.status === 'completed') return [{ type: 'GitEffectCompleted', effectId: receipt.effectId, commit: receipt.commit }, ...complete(doc, receipt.commit)]
  const type = receipt.status === 'uncertain' ? 'GitEffectUncertain' : receipt.status === 'pending' ? 'GitEffectPending' : 'GitEffectFailed'
  if (record.status === (type === 'GitEffectUncertain' ? 'uncertain' : type === 'GitEffectPending' ? 'pending' : 'failed') && record.reason === receipt.reason) return []
  return [{ type, effectId: receipt.effectId, reason: receipt.reason }]
}

export function projectReviewEffect(doc: ReviewDoc, event: ReviewEffectEvent): void {
  if (event.type === 'GitEffectRequested') {
    if (doc.git_effects.some(e => e.plan.effectId === event.effect.effectId)) throw new Error('Duplicate Git effect')
    doc.git_effects.push({ plan: structuredClone(event.effect), status: 'requested', commit: null, reason: null })
    return
  }
  const record = doc.git_effects.find(e => e.plan.effectId === event.effectId)
  if (!record || record.status === 'completed') throw new Error('Missing or already completed Git effect')
  if (event.type === 'GitEffectCompleted') {
    record.status = 'completed'; record.commit = event.commit; record.reason = null
  } else {
    record.status = event.type === 'GitEffectFailed' ? 'failed' : event.type === 'GitEffectPending' ? 'pending' : 'uncertain'
    record.reason = event.reason
  }
}
