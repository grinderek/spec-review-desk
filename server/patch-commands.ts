import { isDeepStrictEqual } from 'node:util'
import { HttpError } from './errors.ts'
import { decideOwnerDecision } from './decision-commands.ts'
import type { GitEffectPlan, GitEffectReceipt } from './git-effect.ts'
import { requestReviewEffect, reviewEffectReceipt } from './review-effects.ts'
import { recordReviewEvents, type Patch, type ReviewDoc, type ReviewDomainEvent } from './review-store.ts'

export type PatchEvent =
  | { type: 'PatchRejected'; threadId: string; index: number }
  | { type: 'PatchRechecked'; threadId: string; index: number; state: 'proposed' | 'stale'; error: string | null; files: string[] }
  | { type: 'PatchApplicationRequested'; threadId: string; index: number; effectId: string }
  | { type: 'PatchApplied'; threadId: string; index: number; effectId: string; commit: string }
  | { type: 'PatchApplicationPending' | 'PatchApplicationUncertain' | 'PatchApplicationFailed'; threadId: string; index: number; effectId: string; reason: string }
export type PatchCommand =
  | { type: 'RejectPatch'; threadId: string; index: number }
  | { type: 'RecheckPatch'; threadId: string; index: number; state: 'proposed' | 'stale'; error: string | null; files: string[] }
  | { type: 'RequestPatchApplication'; threadId: string; index: number; effect: GitEffectPlan }
  | { type: 'RecordPatchApplicationReceipt'; threadId: string; index: number; receipt: GitEffectReceipt }

export function patchAt(doc: ReviewDoc, threadId: string, index: number): Patch {
  const thread = doc.threads.find(t => t.id === threadId)
  if (!thread) throw new HttpError(404, 'unknown_thread', `No thread ${threadId}`)
  const patch = thread.messages[index]?.patch
  if (!patch) throw new HttpError(404, 'unknown_patch', `Message ${index} has no patch`)
  return patch
}
export function decidePatch(doc: ReviewDoc, command: PatchCommand): ReviewDomainEvent[] {
  const patch = patchAt(doc, command.threadId, command.index)
  const target = { threadId: command.threadId, index: command.index }
  if (command.type === 'RejectPatch') {
    if (patch.effect_id || !['proposed', 'stale', 'rejected'].includes(patch.state)) throw new HttpError(409, 'patch_not_rejectable', 'Only an unrequested patch can be rejected')
    return patch.state === 'rejected' ? [] : [{ type: 'PatchRejected', ...target }]
  }
  if (command.type === 'RecheckPatch') {
    if (!['stale', 'proposed'].includes(patch.state) || patch.effect_id) throw new HttpError(409, 'patch_not_stale', 'Only an unrequested stale patch can be re-checked')
    return [{ type: 'PatchRechecked', ...target, state: command.state, error: command.error, files: command.files }]
  }
  if (command.type === 'RequestPatchApplication') {
    if (patch.state !== 'proposed' || patch.effect_id) throw new HttpError(409, 'patch_not_proposed', 'Only a proposed patch can start an application')
    const message = doc.threads.find(t => t.id === command.threadId)!.messages[command.index]!
    for (const id of message.resolves ?? []) {
      const binding = message.decision_bindings?.find(item => item.decisionId === id)
      const decision = doc.decisions.find(item => item.id === id)
      if (!binding || !decision || decision.status !== 'decided' || !isDeepStrictEqual(decision.scope, binding.scope) || !isDeepStrictEqual(decision.choice, binding.choice)) {
        throw new HttpError(409, 'patch_decision_changed', 'The owner decision changed since this patch was requested. Ask for a fresh correction or reject this patch.')
      }
    }
    if (command.effect.purpose.kind !== 'review-patch' || command.effect.purpose.ref !== `${command.threadId}:${command.index}`) throw new HttpError(422, 'patch_effect_mismatch', 'Git intent does not identify this patch')
    return [...requestReviewEffect(doc, command.effect), { type: 'PatchApplicationRequested', ...target, effectId: command.effect.effectId }]
  }
  if (patch.effect_id !== command.receipt.effectId) throw new HttpError(409, 'patch_effect_mismatch', 'The receipt does not belong to this patch')
  const events = reviewEffectReceipt(doc, command.receipt, (state, commit) => [
    { type: 'PatchApplied', ...target, effectId: command.receipt.effectId, commit },
    ...decideOwnerDecision(state, { type: 'RecordResolvedDecisions', bindings: state.threads.find(t => t.id === command.threadId)!.messages[command.index]!.decision_bindings ?? [], commit }),
  ])
  if (command.receipt.status !== 'completed' && events.length) {
    const type = command.receipt.status === 'uncertain' ? 'PatchApplicationUncertain' : command.receipt.status === 'pending' ? 'PatchApplicationPending' : 'PatchApplicationFailed'
    events.push({ type, ...target, effectId: command.receipt.effectId, reason: command.receipt.reason })
  }
  return events
}
export function projectPatch(doc: ReviewDoc, event: PatchEvent): void {
  const patch = patchAt(doc, event.threadId, event.index)
  if (event.type === 'PatchRejected') {
    if (patch.effect_id || !['proposed', 'stale'].includes(patch.state)) throw new Error('Patch cannot be rejected from its current state')
    patch.state = 'rejected'; return
  }
  if (event.type === 'PatchRechecked') {
    if (patch.effect_id || !['proposed', 'stale'].includes(patch.state)) throw new Error('Patch cannot be rechecked from its current state')
    patch.state = event.state; patch.error = event.error; patch.files = [...event.files]; return
  }
  if (event.type === 'PatchApplicationRequested') {
    if (patch.state !== 'proposed' || patch.effect_id) throw new Error('Patch application requested from invalid state')
    const effect = doc.git_effects.find(record => record.plan.effectId === event.effectId)
    if (!effect || effect.status !== 'requested' || effect.plan.purpose.kind !== 'review-patch' || effect.plan.purpose.ref !== `${event.threadId}:${event.index}`) throw new Error('Patch application has no matching Git intent')
    patch.state = 'applying'; patch.effect_id = event.effectId; patch.error = null; return
  }
  if (patch.effect_id !== event.effectId) throw new Error('Patch receipt refers to a different effect')
  const effect = doc.git_effects.find(record => record.plan.effectId === event.effectId)
  if (event.type === 'PatchApplied') {
    if (!effect || effect.status !== 'completed' || effect.commit !== event.commit) throw new Error('Patch has no completed Git receipt')
    patch.state = 'applied'; patch.commit = event.commit; patch.error = null }
  else { patch.state = event.type === 'PatchApplicationUncertain' ? 'uncertain' : event.type === 'PatchApplicationPending' ? 'applying' : 'proposed'; patch.error = event.reason }
}
export async function executePatchCommand(dir: string, command: PatchCommand): Promise<void> {
  await recordReviewEvents(dir, async doc => ({ events: decidePatch(doc, command) }), 'patch-command')
}
