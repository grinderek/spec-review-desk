import { describe, expect, it } from 'vitest'
import { corpusKey, parseRunMessages } from './run-messages.ts'

const URI = 'features/health_score/thread_state.feature'
const envelopes = [
  { gherkinDocument: { uri: URI, feature: { children: [
    { background: { id: 'b1', steps: [] } },
    { scenario: { id: 's1', name: 'Plain', examples: [] } },
    { scenario: { id: 's2', name: 'Outline', examples: [{ tableBody: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }] } },
  ] } } },
  { pickle: { id: 'p1', uri: URI, name: 'Plain', astNodeIds: ['s1'], steps: [{ id: 'ps1', text: 'a step' }] } },
  { pickle: { id: 'p2', uri: URI, name: 'Outline', astNodeIds: ['s2', 'r1'], steps: [{ id: 'ps2', text: 'row one' }] } },
  { pickle: { id: 'p3', uri: URI, name: 'Outline', astNodeIds: ['s2', 'r2'], steps: [{ id: 'ps3', text: 'row two' }] } },
  { pickle: { id: 'p4', uri: URI, name: 'Outline', astNodeIds: ['s2', 'r3'], steps: [{ id: 'ps4', text: 'row three' }] } },
  { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 'h1', hookId: 'hook' }, { id: 'ts1', pickleStepId: 'ps1' }] } },
  { testCase: { id: 'tc2', pickleId: 'p2', testSteps: [{ id: 'ts2', pickleStepId: 'ps2' }] } },
  { testCase: { id: 'tc3', pickleId: 'p3', testSteps: [{ id: 'ts3', pickleStepId: 'ps3' }] } },
  { testCase: { id: 'tc4', pickleId: 'p4', testSteps: [{ id: 'ts4', pickleStepId: 'ps4' }] } },
  { testCaseStarted: { id: 'c1', testCaseId: 'tc1' } },
  { testStepFinished: { testCaseStartedId: 'c1', testStepId: 'h1', testStepResult: { status: 'PASSED' } } },
  { testStepFinished: { testCaseStartedId: 'c1', testStepId: 'ts1', testStepResult: { status: 'PASSED' } } },
  { testCaseStarted: { id: 'c2', testCaseId: 'tc2' } },
  { testStepFinished: { testCaseStartedId: 'c2', testStepId: 'ts2', testStepResult: { status: 'PASSED' } } },
  { testCaseStarted: { id: 'c3', testCaseId: 'tc3' } },
  { testStepFinished: { testCaseStartedId: 'c3', testStepId: 'ts3', testStepResult: { status: 'FAILED', message: 'expected 97, got 100' } } },
  { testCaseStarted: { id: 'c4', testCaseId: 'tc4' } },
  { testStepFinished: { testCaseStartedId: 'c4', testStepId: 'ts4', testStepResult: { status: 'UNDEFINED' } } },
  { testRunFinished: { success: false, timestamp: { seconds: 1790000000, nanos: 0 } } },
]
const ndjson = `${envelopes.map((e) => JSON.stringify(e)).join('\n')}\nnot json at all\n`

describe('parseRunMessages', () => {
  it('keys scenarios by feature basename and title', () => {
    expect(corpusKey('features/thread_state.feature', 'Plain')).toBe('thread_state.feature::Plain')
  })

  it('reports each scenario, the worst row of an outline and the failing step', () => {
    const run = parseRunMessages(ndjson)
    expect(run.scenarios['thread_state.feature::Plain']).toEqual({ status: 'passed', failure: null, rows: null })
    expect(run.scenarios['thread_state.feature::Outline']).toEqual({
      status: 'failed',
      failure: { step: 'row two', message: 'expected 97, got 100' },
      rows: ['passed', 'failed', 'undefined'],
    })
    expect(run.totals).toEqual({ passed: 2, failed: 1, other: 1 })
    expect(run.finishedAt).toBe(new Date(1790000000 * 1000).toISOString())
  })

  it('returns an empty run for empty input', () => {
    expect(parseRunMessages('')).toEqual({ scenarios: {}, totals: { passed: 0, failed: 0, other: 0 }, finishedAt: null })
  })
})
