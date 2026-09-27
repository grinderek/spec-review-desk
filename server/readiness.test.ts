import { describe, expect, it } from 'vitest'
import { computeReadiness, type ReadinessInput } from './readiness.ts'
import type { Effective, Thread } from './review-store.ts'

const approved: Effective = { status: 'approved', changedSinceApproval: false, approvedCommit: 'abc' }
const pending: Effective = { status: 'pending', changedSinceApproval: false, approvedCommit: null }
const thread = (status: Thread['status']): Thread => ({ id: 't', anchor: 'change', ref: '', status, messages: [] })
const ready: ReadinessInput = {
  scenarios: [approved, approved], phrases: [approved], threads: [thread('resolved')],
  decisions: [],
  joinKey: { ok: true, missingInFeatures: [], missingInSpecs: [], duplicateTitles: [] },
  uncatalogued: 0, parseErrors: 0, reviewValid: true,
}

describe('computeReadiness', () => {
  it('is ready when everything is approved and resolved', () => {
    expect(computeReadiness(ready)).toEqual({ ready: true, reasons: [] })
  })

  it('names every blocking reason', () => {
    const result = computeReadiness({
      scenarios: [approved, pending], phrases: [pending, pending], threads: [thread('open'), thread('answered')],
      decisions: [{ blocking: true, status: 'open' }, { blocking: false, status: 'open' }, { blocking: true, status: 'recorded' }],
      joinKey: { ok: false, missingInFeatures: ['x'], missingInSpecs: [], duplicateTitles: [] },
      uncatalogued: 1, parseErrors: 1, reviewValid: false,
    })
    expect(result.ready).toBe(false)
    expect(result.reasons).toEqual([
      'review.yaml is invalid',
      '1 file failed to parse',
      '1 scenario not approved',
      '2 phrases not approved',
      '2 threads not resolved',
      '1 blocking decision open',
      'join key: 1 spec title without a scenario, 0 scenarios without a spec line, 0 duplicate titles',
      '1 uncatalogued step',
    ])
  })

  it('is never ready without scenarios', () => {
    expect(computeReadiness({ ...ready, scenarios: [] }).reasons).toEqual(['no scenarios'])
  })
})

describe('blocking decisions', () => {
  it('block while open or decided, never when non-blocking, recorded or dismissed', () => {
    const decisions = [
      { blocking: true, status: 'open' as const },
      { blocking: true, status: 'decided' as const },
      { blocking: false, status: 'open' as const },
      { blocking: true, status: 'recorded' as const },
      { blocking: true, status: 'dismissed' as const },
    ]
    expect(computeReadiness({ ...ready, decisions }).reasons).toEqual(['2 blocking decisions open'])
    expect(computeReadiness({ ...ready, decisions: [decisions[0]!] }).reasons).toEqual(['1 blocking decision open'])
  })
})
