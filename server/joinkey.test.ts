import { describe, expect, it } from 'vitest'
import { checkJoinKey, specTitles } from './joinkey.ts'
import { SPEC_MD } from './testing/fixtures.ts'

describe('join key', () => {
  it('reads the four-hash scenario headings of spec.md', () => {
    expect(specTitles(SPEC_MD)).toEqual(["The founder's reply resolves a waiting thread", 'A waiting thread is weighted by its age'])
    expect(specTitles('### Scenario: three hashes do not count\n#### Scenario:   padded   \n')).toEqual(['padded'])
  })

  it('passes when both sides name the same titles', () => {
    expect(checkJoinKey(['a', 'b'], ['b', 'a']).ok).toBe(true)
  })

  it('lists titles missing on either side and duplicates', () => {
    expect(checkJoinKey(['a', 'b', 'b'], ['a', 'c'])).toEqual({ ok: false, missingInFeatures: ['b'], missingInSpecs: ['c'], duplicateTitles: ['b'] })
  })
})
