import { isDeepStrictEqual } from 'node:util'
import {
  decideDecision, dismissDecision, findDecision, isActive, reattachDecision,
  type DecisionChoiceInput,
} from './decision-model.ts'
import { HttpError } from './errors.ts'
import { recordReviewEvents, type DecisionBinding, type DecisionRecord, type ReviewDoc } from './review-store.ts'

export type DecisionEvent =
  | { type: 'OwnerDecisionRaised'; decision: DecisionRecord }
  | { type: 'OwnerDecisionChosen'; decisionId: string; choice: NonNullable<DecisionRecord['choice']> }
  | { type: 'OwnerDecisionDismissed'; decisionId: string; reason: string; at: string }
  | { type: 'OwnerDecisionReattached'; decisionId: string; to: string }
  | { type: 'OwnerDecisionRecorded'; decisionId: string; recorded: NonNullable<DecisionRecord['recorded']> }

export type DecisionCommand =
  | { type: 'RaiseOwnerDecisions'; decisions: readonly DecisionRecord[] }
  | { type: 'ChooseOwnerDecision'; id: string; choice: DecisionChoiceInput; at: string }
  | { type: 'DismissOwnerDecision'; id: string; reason: string; at: string }
  | { type: 'ReattachOwnerDecision'; id: string; to: string }
  | { type: 'RecordOwnerDecision'; id: string; recorded: NonNullable<DecisionRecord['recorded']> }
  | { type: 'RecordResolvedDecisions'; bindings: readonly DecisionBinding[]; commit: string }

// Each command decides facts explicitly. Projection never invokes this function or repeats an
// owner's choice, an agent call, or the Git operation that confirmed a recorded decision.
export function decideOwnerDecision(doc: ReviewDoc, command: DecisionCommand): DecisionEvent[] {
  if (command.type === 'DismissOwnerDecision' || command.type === 'ReattachOwnerDecision') {
    const patchEffects = new Set(doc.threads.flatMap(t => t.messages.filter(m => m.resolves?.includes(command.id)).flatMap(m => m.patch?.effect_id ? [m.patch.effect_id] : [])))
    if (doc.git_effects.some(e => ['requested', 'pending', 'uncertain'].includes(e.status) &&
      ((e.plan.purpose.kind === 'record-decision' && e.plan.purpose.ref === command.id) || patchEffects.has(e.plan.effectId)))) {
      throw new HttpError(409, 'git_effect_pending', 'Finish or recover the pending decision recording before changing this decision')
    }
  }
  switch (command.type) {
    case 'RaiseOwnerDecisions': {
      const ids = new Set(doc.decisions.map(d => d.id))
      return command.decisions.map(decision => {
        if (ids.has(decision.id)) throw new HttpError(409, 'duplicate_decision', `Decision ${decision.id} already exists`)
        if (decision.status !== 'open' || decision.choice || decision.recorded || decision.dismissed) {
          throw new HttpError(422, 'invalid_new_decision', 'A new owner decision must be open without a choice or result')
        }
        ids.add(decision.id)
        return { type: 'OwnerDecisionRaised', decision: structuredClone(decision) }
      })
    }
    case 'ChooseOwnerDecision': {
      const decision = findDecision(decideDecision(doc, command.id, command.choice, command.at), command.id)
      return [{ type: 'OwnerDecisionChosen', decisionId: command.id, choice: decision.choice! }]
    }
    case 'DismissOwnerDecision': {
      const decision = findDecision(dismissDecision(doc, command.id, command.reason, command.at), command.id)
      return [{ type: 'OwnerDecisionDismissed', decisionId: command.id, ...decision.dismissed! }]
    }
    case 'ReattachOwnerDecision': {
      const previous = findDecision(doc, command.id)
      const next = findDecision(reattachDecision(doc, command.id, command.to), command.id)
      return isDeepStrictEqual(previous.scope, next.scope) ? [] : [{ type: 'OwnerDecisionReattached', decisionId: command.id, to: command.to }]
    }
    case 'RecordOwnerDecision': {
      if (!command.recorded.commit) throw new HttpError(422, 'commit_required', 'A recorded decision requires a confirmed commit')
      const previous = findDecision(doc, command.id)
      if (previous.status === 'recorded' && isDeepStrictEqual(previous.recorded, command.recorded)) return []
      if (previous.status !== 'decided') throw new HttpError(409, 'decision_not_decided', `Decision ${command.id} is ${previous.status}, not decided`)
      return [{ type: 'OwnerDecisionRecorded', decisionId: command.id, recorded: { ...command.recorded } }]
    }
    case 'RecordResolvedDecisions': {
      if (!command.commit) throw new HttpError(422, 'commit_required', 'Recording a resolved decision requires a confirmed commit')
      return doc.decisions.flatMap(decision => {
        const binding = command.bindings.find(item => item.decisionId === decision.id)
        return binding && decision.status === 'decided' && decision.scope.kind === 'scenario'
          && isDeepStrictEqual(decision.scope, binding.scope) && isDeepStrictEqual(decision.choice, binding.choice)
          ? [{ type: 'OwnerDecisionRecorded' as const, decisionId: decision.id, recorded: { how: 'patch' as const, commit: command.commit } }]
          : []
      })
    }
  }
}

export function projectOwnerDecision(doc: ReviewDoc, event: DecisionEvent): void {
  if (event.type === 'OwnerDecisionRaised') {
    if (doc.decisions.some(d => d.id === event.decision.id)) throw new Error(`Duplicate decision ${event.decision.id}`)
    doc.decisions.push(structuredClone(event.decision))
    return
  }
  const decision = doc.decisions.find(d => d.id === event.decisionId)
  if (!decision) throw new Error(`Decision event refers to missing decision ${event.decisionId}`)
  if (event.type === 'OwnerDecisionChosen') {
    if (decision.status !== 'open') throw new Error(`Decision ${event.decisionId} cannot be chosen from ${decision.status}`)
    decision.status = 'decided'
    decision.choice = structuredClone(event.choice)
  } else if (event.type === 'OwnerDecisionDismissed') {
    if (!isActive(decision)) throw new Error(`Decision ${event.decisionId} cannot be dismissed from ${decision.status}`)
    decision.status = 'dismissed'
    decision.dismissed = { reason: event.reason, at: event.at }
  } else if (event.type === 'OwnerDecisionReattached') {
    if (!isActive(decision) || decision.scope.kind !== 'scenario') throw new Error(`Decision ${event.decisionId} cannot be reattached`)
    decision.scope = { kind: 'scenario', key: event.to }
  } else if (event.type === 'OwnerDecisionRecorded') {
    if (decision.status !== 'decided') throw new Error(`Decision ${event.decisionId} cannot be recorded from ${decision.status}`)
    decision.status = 'recorded'
    decision.recorded = structuredClone(event.recorded)
  }
}

export async function executeOwnerDecision(dir: string, command: DecisionCommand, origin: 'decision-command' | 'fixture' = 'decision-command'): Promise<void> {
  await recordReviewEvents(dir, async doc => ({ events: decideOwnerDecision(doc, command) }), origin)
}
