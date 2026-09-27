import { describe, expect, it } from 'vitest'
import {
  addDecisions, decideDecision, decisionsFromReply, dismissDecision, findDecision, isActive, ownerDecision, ownerDecisionText, pendingBlocking,
  reattachDecision, recordDecision, recordResolved, runDecisions, setRecordedCommit,
} from './decision-model.ts'
import type { ReplyDecision } from './protocol.ts'
import { type DecisionRecord, emptyReview, type ReviewDoc } from './review-store.ts'

const KEY = 'features/x.feature::A title'
const AT = '2026-09-24T10:00:00.000Z'
const agentItem: ReplyDecision = {
  id: 'age_basis',
  question: 'Business or calendar age?',
  scope: { kind: 'scenario', key: KEY },
  options: [
    { id: 'business', label: 'Business hours', consequence: 'Weekends do not count.' },
    { id: 'calendar', label: 'Calendar hours', consequence: 'Weekends count.' },
  ],
  recommended: 'business',
  blocking: true,
}
let counter = 0
const ids = (): string => `d_${String(++counter).padStart(8, '0')}`
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

function seeded(): { doc: ReviewDoc; agent: DecisionRecord; owner: DecisionRecord } {
  const agent = decisionsFromReply([agentItem], { kind: 'thread', id: 't_1' }, AT, ids)[0]!
  const owner = ownerDecision({ question: 'Ship behind a flag?', scope: { kind: 'change' }, blocking: false, options: [] }, AT, ids)
  return { doc: addDecisions(emptyReview(), [agent, owner]), agent, owner }
}

describe('creating decisions', () => {
  it('turns reply items into open server records that keep the agent id', () => {
    const { agent, owner } = seeded()
    expect(agent).toMatchObject({
      agent_id: 'age_basis', source: { kind: 'thread', id: 't_1' }, status: 'open', recommended: 'business',
      choice: null, recorded: null, dismissed: null, created_at: AT,
    })
    expect(agent.id).toMatch(/^d_\d{8}$/)
    expect(owner).toMatchObject({ agent_id: null, source: { kind: 'owner' }, recommended: null, options: [] })
  })
})

describe('decide', () => {
  it('requires a known option when there are options, and a note when there are none', () => {
    const { doc, agent, owner } = seeded()
    expect(codeOf(() => decideDecision(doc, agent.id, { option: null, note: '' }, AT))).toBe('option_required')
    expect(codeOf(() => decideDecision(doc, agent.id, { option: 'hourly', note: '' }, AT))).toBe('unknown_option')
    expect(codeOf(() => decideDecision(doc, owner.id, { option: null, note: '  ' }, AT))).toBe('note_required')
    expect(codeOf(() => decideDecision(doc, owner.id, { option: 'x', note: 'y' }, AT))).toBe('unknown_option')
    expect(codeOf(() => decideDecision(doc, 'd_nope', { option: null, note: 'y' }, AT))).toBe('unknown_decision')
  })

  it('records the choice without touching the input and refuses a second decide', () => {
    const { doc, agent } = seeded()
    const frozen = JSON.stringify(doc)
    const next = decideDecision(doc, agent.id, { option: 'business', note: ' Weekdays. ' }, AT)
    expect(JSON.stringify(doc)).toBe(frozen)
    expect(findDecision(next, agent.id)).toMatchObject({ status: 'decided', choice: { option: 'business', note: 'Weekdays.', at: AT } })
    expect(codeOf(() => decideDecision(next, agent.id, { option: 'calendar', note: '' }, AT))).toBe('decision_not_open')
  })
})

describe('record, dismiss, re-attach', () => {
  it('records only a decided decision and fills its commit later', () => {
    const { doc, agent } = seeded()
    expect(codeOf(() => recordDecision(doc, agent.id, { how: 'patch', commit: null }))).toBe('decision_not_decided')
    const recorded = recordDecision(decideDecision(doc, agent.id, { option: 'business', note: '' }, AT), agent.id, { how: 'patch', commit: null })
    expect(findDecision(setRecordedCommit(recorded, agent.id, 'abc1234'), agent.id)).toMatchObject({
      status: 'recorded', recorded: { how: 'patch', commit: 'abc1234' },
    })
  })

  it('dismisses an open or decided decision with a reason, never a closed one', () => {
    const { doc, agent, owner } = seeded()
    const dismissed = dismissDecision(doc, owner.id, ' Not now. ', AT)
    expect(findDecision(dismissed, owner.id)).toMatchObject({ status: 'dismissed', dismissed: { reason: 'Not now.', at: AT } })
    expect(codeOf(() => dismissDecision(dismissed, owner.id, 'again', AT))).toBe('decision_closed')
    const decided = decideDecision(doc, agent.id, { option: 'business', note: '' }, AT)
    expect(findDecision(dismissDecision(decided, agent.id, 'Changed my mind.', AT), agent.id).status).toBe('dismissed')
  })

  it('re-attaches scenario decisions only', () => {
    const { doc, agent, owner } = seeded()
    expect(findDecision(reattachDecision(doc, agent.id, 'features/x.feature::Renamed'), agent.id).scope).toEqual({
      kind: 'scenario', key: 'features/x.feature::Renamed',
    })
    expect(codeOf(() => reattachDecision(doc, owner.id, KEY))).toBe('not_scenario_scoped')
  })

  it('records resolved decisions by patch only when they are decided and scenario-scoped', () => {
    const { doc, agent, owner } = seeded()
    const decided = decideDecision(decideDecision(doc, agent.id, { option: 'business', note: '' }, AT), owner.id, { option: null, note: 'Yes.' }, AT)
    const next = recordResolved(decided, [agent.id, owner.id, 'd_nope'], 'abc1234')
    expect(findDecision(next, agent.id)).toMatchObject({ status: 'recorded', recorded: { how: 'patch', commit: 'abc1234' } })
    expect(findDecision(next, owner.id).status).toBe('decided')
  })
})

describe('queries and the owner message', () => {
  it('finds active, blocking and per-run decisions', () => {
    const { doc, agent, owner } = seeded()
    const fromRun = decisionsFromReply([agentItem], { kind: 'apply', run: 'r_1' }, AT, ids)[0]!
    const all = addDecisions(doc, [fromRun])
    expect(isActive(agent)).toBe(true)
    expect(pendingBlocking(all.decisions).map((d) => d.id)).toEqual([agent.id, fromRun.id])
    expect(runDecisions(all, 'r_1').map((d) => d.id)).toEqual([fromRun.id])
    expect(isActive(findDecision(dismissDecision(all, owner.id, 'x', AT), owner.id))).toBe(false)
  })

  it('tells the agent what was decided and asks for the patch', () => {
    const { doc, agent } = seeded()
    const decided = findDecision(decideDecision(doc, agent.id, { option: 'business', note: 'Weekdays only.' }, AT), agent.id)
    const text = ownerDecisionText(decided, '2026-09-24')
    expect(text).toContain(`Owner decided ${agent.id} ("Business or calendar age?"): Business hours.`)
    expect(text).toContain('Note: Weekdays only.')
    expect(text).toContain('Produce the patch: "# Owner decision 2026-09-24: …" above the scenario plus the scenario/spec.md change.')
    expect(text).toContain(`List "${agent.id}" in resolves.`)
  })
})
