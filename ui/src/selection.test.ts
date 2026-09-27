import { describe, expect, it } from 'vitest'
import { hashOf, readHash } from './selection.ts'

describe('selection hashes', () => {
  it('reads changes, initiatives and the New feature form, and writes them back', () => {
    expect(readHash('#/abc/add-x')).toEqual({ kind: 'change', id: { wt: 'abc', name: 'add-x' } })
    expect(readHash('#/i/abc/health-score')).toEqual({ kind: 'initiative', id: { wt: 'abc', name: 'health-score' } })
    expect(readHash('#/new')).toEqual({ kind: 'new' })
    expect(readHash('')).toBeNull()
    expect(readHash('#/i/abc')).toEqual({ kind: 'change', id: { wt: 'i', name: 'abc' } })
    for (const hash of ['#/abc/add-x', '#/i/abc/health-score', '#/new']) expect(hashOf(readHash(hash)!)).toBe(hash)
  })
})
