import { describe, expect, it } from 'vitest'
import type { DecisionView } from '../../server/change-view.ts'
import { gateCounts, history, inbox, optionIds, outcomeLine, resumeState, scenarioOpen, scopeLabel, sourceLabel } from './decision-view.ts'

const make = (over: Partial<DecisionView>): DecisionView => ({
  id: 'd_1', agent_id: null, source: { kind: 'owner' }, question: 'Q?', scope: { kind: 'change' }, options: [], recommended: null,
  blocking: false, status: 'open', choice: null, recorded: null, dismissed: null, created_at: '2026-09-24T10:00:00.000Z', orphaned: false,
  ...over,
})
const OPTION = { id: 'business', label: 'Business hours', consequence: 'Weekends do not count.' }

describe('inbox', () => {
  it('shows open and decided first, blocking first, newest first; "open" hides closed ones', () => {
    const items = [
      make({ id: 'closed', status: 'recorded', blocking: true }),
      make({ id: 'old_open', created_at: '2026-09-23T10:00:00.000Z' }),
      make({ id: 'blocking', blocking: true, status: 'decided' }),
      make({ id: 'new_open', created_at: '2026-09-25T10:00:00.000Z' }),
    ]
    expect(inbox(items, 'all').map((d) => d.id)).toEqual(['blocking', 'new_open', 'old_open', 'closed'])
    expect(inbox(items, 'open').map((d) => d.id)).toEqual(['blocking', 'new_open', 'old_open'])
  })
})

describe('labels', () => {
  it('names scope, source and outcome', () => {
    expect(scopeLabel(make({ scope: { kind: 'scenario', key: 'features/x.feature::A title' } }))).toBe('Scenario: A title')
    expect(scopeLabel(make({}))).toBe('Whole change')
    expect(sourceLabel(make({ source: { kind: 'apply', run: 'r_1' } }))).toBe('raised by Apply r_1')
    expect(sourceLabel(make({ source: { kind: 'thread', id: 't_1' } }))).toBe('raised in a thread')
    expect(sourceLabel(make({}))).toBe('added by you')
    expect(outcomeLine(make({}))).toBeNull()
    const choice = { option: 'business', note: '', at: 'now' }
    expect(outcomeLine(make({ options: [OPTION], status: 'decided', choice }))).toBe("Decided: Business hours — waiting for the agent's patch")
    expect(outcomeLine(make({ options: [OPTION], status: 'recorded', choice, recorded: { how: 'patch', commit: 'abc1234' } })))
      .toBe('Business hours — recorded by patch · abc1234')
    expect(outcomeLine(make({ status: 'recorded', choice: { option: null, note: 'Yes.', at: 'now' }, recorded: { how: 'decisions_md', commit: null } })))
      .toBe('Yes. — recorded in decisions.md · uncommitted')
    expect(outcomeLine(make({ status: 'dismissed', dismissed: { reason: 'Out of scope.', at: 'now' } }))).toBe('Dismissed: Out of scope.')
  })
})

describe('history', () => {
  it('merges "# Owner decision" comments and decisions.md entries, newest first', () => {
    const features = [{ scenarios: [{ key: 'features/x.feature::A', title: 'A', decisions: [{ date: '2026-09-23', text: 'rows weigh by age.', commit: 'abc1234' }] }] }]
    const log = [{ date: '2026-09-24', question: 'Ship behind a flag?', decision: '', note: 'Yes.', source: 'owner · d_1', id: 'd_1' }]
    expect(history(features, log)).toEqual([
      { kind: 'decisions_md', date: '2026-09-24', title: 'Ship behind a flag?', text: 'Note: Yes.', commit: null, key: null },
      { kind: 'gherkin', date: '2026-09-23', title: 'A', text: 'rows weigh by age.', commit: 'abc1234', key: 'features/x.feature::A' },
    ])
  })
})

describe('counts', () => {
  it('counts the gate, a scenario pill and an Apply resume', () => {
    const run = { kind: 'apply' as const, run: 'r_1' }
    const items = [
      make({ id: 'a', blocking: true, scope: { kind: 'scenario', key: 'k' }, source: run }),
      make({ id: 'b', status: 'decided', scope: { kind: 'scenario', key: 'k' } }),
      make({ id: 'c', status: 'recorded', blocking: true, source: run }),
      make({ id: 'd', status: 'dismissed', scope: { kind: 'scenario', key: 'k' } }),
    ]
    expect(gateCounts(items)).toEqual({ open: 2, blocking: 1 })
    expect(scenarioOpen(items, 'k').map((d) => d.id)).toEqual(['a', 'b'])
    expect(resumeState(items, 'r_1')).toEqual({ blocking: 2, settled: 1, ready: false })
    expect(resumeState(items.filter((d) => d.id !== 'a'), 'r_1')).toEqual({ blocking: 1, settled: 1, ready: true })
  })
})

describe('optionIds', () => {
  it('builds unique slugs, falling back for labels without Latin letters', () => {
    expect(optionIds(['Count partial days', 'Über-Wert', 'Count partial days', 'Только целые']))
      .toEqual(['count_partial_days', 'uber_wert', 'count_partial_days_3', 'option_4'])
  })
})
