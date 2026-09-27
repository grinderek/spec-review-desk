import { HttpError } from './errors.ts'
import type { ReplyDecision } from './protocol.ts'
import { type DecisionRecord, newId, type ReviewDoc } from './review-store.ts'

// Every decision status change goes through these pure transitions (spec §5/§6). They return a
// new document and throw HttpError for a transition the current status does not allow.
export type DecisionSource = DecisionRecord['source']
export interface DecisionChoiceInput { option: string | null; note: string }
export interface OwnerDecisionInput {
  question: string
  scope: DecisionRecord['scope']
  blocking: boolean
  options: DecisionRecord['options']
}

export const isActive = (d: Pick<DecisionRecord, 'status'>): boolean => d.status === 'open' || d.status === 'decided'

export const pendingBlocking = <T extends Pick<DecisionRecord, 'status' | 'blocking'>>(decisions: readonly T[]): T[] =>
  decisions.filter((d) => d.blocking && isActive(d))

export function findDecision(doc: ReviewDoc, id: string): DecisionRecord {
  const found = doc.decisions.find((d) => d.id === id)
  if (!found) throw new HttpError(404, 'unknown_decision', `No decision ${id}`)
  return found
}

function mapDecision(doc: ReviewDoc, id: string, fn: (d: DecisionRecord) => DecisionRecord): ReviewDoc {
  findDecision(doc, id)
  return { ...doc, decisions: doc.decisions.map((d) => (d.id === id ? fn(d) : d)) }
}

export const addDecisions = (doc: ReviewDoc, records: readonly DecisionRecord[]): ReviewDoc =>
  records.length ? { ...doc, decisions: [...doc.decisions, ...records] } : doc

export function decisionsFromReply(
  items: readonly ReplyDecision[],
  source: DecisionSource,
  at: string,
  makeId: () => string = () => newId('d'),
): DecisionRecord[] {
  return items.map((item): DecisionRecord => ({
    id: makeId(),
    agent_id: item.id,
    source,
    question: item.question,
    scope: item.scope,
    options: item.options.map((o) => ({ ...o })),
    recommended: item.recommended,
    blocking: item.blocking,
    status: 'open',
    choice: null,
    recorded: null,
    dismissed: null,
    created_at: at,
  }))
}

export function ownerDecision(input: OwnerDecisionInput, at: string, makeId: () => string = () => newId('d')): DecisionRecord {
  return {
    id: makeId(),
    agent_id: null,
    source: { kind: 'owner' },
    question: input.question,
    scope: input.scope,
    options: input.options.map((o) => ({ ...o })),
    recommended: null,
    blocking: input.blocking,
    status: 'open',
    choice: null,
    recorded: null,
    dismissed: null,
    created_at: at,
  }
}

export function decideDecision(doc: ReviewDoc, id: string, choice: DecisionChoiceInput, at: string): ReviewDoc {
  return mapDecision(doc, id, (d): DecisionRecord => {
    if (d.status !== 'open') throw new HttpError(409, 'decision_not_open', `Decision ${id} is ${d.status}, not open`)
    const note = choice.note.trim()
    if (d.options.length) {
      if (choice.option === null) throw new HttpError(422, 'option_required', 'Pick one of the options')
      if (!d.options.some((o) => o.id === choice.option)) throw new HttpError(422, 'unknown_option', `No option ${choice.option} in decision ${id}`)
    } else {
      if (choice.option !== null) throw new HttpError(422, 'unknown_option', `Decision ${id} has no options`)
      if (!note) throw new HttpError(422, 'note_required', 'A decision without options needs a note')
    }
    return { ...d, status: 'decided', choice: { option: choice.option, note, at } }
  })
}

export function recordDecision(doc: ReviewDoc, id: string, recorded: NonNullable<DecisionRecord['recorded']>): ReviewDoc {
  return mapDecision(doc, id, (d): DecisionRecord => {
    if (d.status !== 'decided') throw new HttpError(409, 'decision_not_decided', `Decision ${id} is ${d.status}, not decided`)
    return { ...d, status: 'recorded', recorded: { ...recorded } }
  })
}

export const setRecordedCommit = (doc: ReviewDoc, id: string, commit: string): ReviewDoc =>
  mapDecision(doc, id, (d): DecisionRecord => (d.recorded ? { ...d, recorded: { ...d.recorded, commit } } : d))

export function dismissDecision(doc: ReviewDoc, id: string, reason: string, at: string): ReviewDoc {
  return mapDecision(doc, id, (d): DecisionRecord => {
    if (!isActive(d)) throw new HttpError(409, 'decision_closed', `Decision ${id} is already ${d.status}`)
    return { ...d, status: 'dismissed', dismissed: { reason: reason.trim(), at } }
  })
}

export function reattachDecision(doc: ReviewDoc, id: string, to: string): ReviewDoc {
  return mapDecision(doc, id, (d): DecisionRecord => {
    if (d.scope.kind !== 'scenario') throw new HttpError(409, 'not_scenario_scoped', `Decision ${id} is scoped to the whole change`)
    if (!isActive(d)) throw new HttpError(409, 'decision_closed', `Decision ${id} is already ${d.status}`)
    return { ...d, scope: { kind: 'scenario', key: to } }
  })
}

// A committed patch records the decided, scenario-scoped decisions its reply resolves (spec §6).
export function recordResolved(doc: ReviewDoc, ids: readonly string[], commit: string): ReviewDoc {
  const wanted = new Set(ids)
  return {
    ...doc,
    decisions: doc.decisions.map((d): DecisionRecord =>
      wanted.has(d.id) && d.status === 'decided' && d.scope.kind === 'scenario' ? { ...d, status: 'recorded', recorded: { how: 'patch', commit } } : d),
  }
}

export const runDecisions = (doc: ReviewDoc, runId: string): DecisionRecord[] =>
  doc.decisions.filter((d) => d.source.kind === 'apply' && d.source.run === runId)

export function ownerDecisionText(d: DecisionRecord, today: string): string {
  const option = d.options.find((o) => o.id === d.choice?.option)
  return [
    `Owner decided ${d.id} ("${d.question}"): ${option ? option.label : '(no option — see the note)'}.`,
    `Note: ${d.choice?.note || '—'}`,
    `Produce the patch: "# Owner decision ${today}: …" above the scenario plus the scenario/spec.md change.`,
    `List "${d.id}" in resolves.`,
  ].join('\n')
}
