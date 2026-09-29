import { describe, expect, it } from 'vitest'
import { makeClassifier, parseCatalog } from './catalog.ts'
import { type Classify, FeatureParseError, parseFeature, unclassified } from './gherkin.ts'
import { FEATURE, NEW_STEPS_MD, STEPS_MD } from './testing/fixtures.ts'

const FILE = 'features/thread_state.feature'
const parse = (source: string, classify: Classify = unclassified) => parseFeature(source, FILE, classify)

describe('parseFeature', () => {
  it('reads the feature, its background and both scenarios', () => {
    const feature = parse(FEATURE)
    expect(feature).toMatchObject({ file: FILE, name: 'Threads are weighed for the inbox pillar', tags: ['@thread-state'] })
    expect(feature.preamble).toEqual(['The world: Tuesday 2026-09-22 14:00 in New York.'])
    expect(feature.background.map((s) => s.keyword)).toEqual(['Given', 'And'])
    expect(feature.scenarios.map((s) => [s.kind, s.key])).toEqual([
      ['Scenario', `${FILE}::The founder's reply resolves a waiting thread`],
      ['Scenario Outline', `${FILE}::A waiting thread is weighted by its age`],
    ])
  })

  it('attaches the comment block above a scenario as decisions and notes', () => {
    const [first, second] = parse(FEATURE).scenarios
    expect(first!.notes).toEqual(['The replied thread is not a candidate, so no verdict is asked for.'])
    expect(first!.decisions).toMatchObject([{ date: '2026-09-23', text: expect.stringContaining('ONE reason, `resolved`') }])
    expect(second!.decisions).toEqual([])
    expect(second!.notes).toEqual([])
  })

  it('keeps data tables, examples and the scenario source', () => {
    const [first, outline] = parse(FEATURE).scenarios
    expect(first!.steps[0]!.table).toEqual([['from', 'arrived'], ['ceo@client.com', '2026-09-22 10:00']])
    expect(outline!.examples).toEqual([{ name: '', header: ['arrived', 'count'], rows: [['2026-09-22 13:00', '1'], ['2026-09-18 16:00', '2']] }])
    expect(first!.source.split('\n')[0]).toBe('  # The replied thread is not a candidate, so no verdict is asked for.')
    expect(outline!.source.trimEnd().endsWith('| 2026-09-18 16:00 | 2     |')).toBe(true)
  })

  it('classifies an outline step against its first Examples row', () => {
    const seen: string[] = []
    parse(FEATURE, (text) => { seen.push(text); return { kind: 'catalog', phrase: null, extended: false, keyword: null, event: null } })
    expect(seen).toContain("the founder's inbox read lists 1 messages")
    expect(seen).not.toContain("the founder's inbox read lists <count> messages")
  })

  it('gives every scenario its event-sourcing shape, background included', () => {
    const classify = makeClassifier(parseCatalog(STEPS_MD), parseCatalog(NEW_STEPS_MD))
    const [first, outline] = parse(FEATURE, classify).scenarios
    expect(first!.shape).toEqual({ given: ['FounderRegistered', 'MailboxSynced'], when: ['SyncGmail'], then: [], warnings: [] })
    expect(outline!.shape).toEqual({ given: ['FounderRegistered', 'MailboxSynced'], when: ['SyncGmail'], then: ['InboxRead'], warnings: [] })
    expect(parse('Feature: F\n  Scenario: S\n    Given x\n    And y\n').scenarios[0]!.shape.warnings).toEqual([
      'no When step — a scenario sends exactly one command or request',
      'no Then step — nothing is expected of the command',
    ])
  })

  describe('hash', () => {
    const hashes = (source: string) => parse(source).scenarios.map((s) => s.hash)
    const base = hashes(FEATURE)

    it('ignores table padding and trailing whitespace', () => {
      const reformatted = FEATURE.replace('| ceo@client.com | 2026-09-22 10:00 |', '|ceo@client.com|2026-09-22 10:00|   ')
      expect(hashes(reformatted)).toEqual(base)
    })

    it('changes every scenario when the background changes', () => {
      const changed = hashes(FEATURE.replace('"America/New_York"', '"Europe/Minsk"'))
      expect(changed[0]).not.toBe(base[0])
      expect(changed[1]).not.toBe(base[1])
    })

    it('changes only the scenario whose comment block changed', () => {
      const changed = hashes(FEATURE.replace('so no verdict is asked for.', 'so no verdict is ever asked for.'))
      expect(changed[0]).not.toBe(base[0])
      expect(changed[1]).toBe(base[1])
    })

    it('changes when an examples row changes', () => {
      expect(hashes(FEATURE.replace('| 2026-09-18 16:00 | 2     |', '| 2026-09-18 16:00 | 3     |'))[1]).not.toBe(base[1])
    })

    it('changes when a scenario tag changes', () => {
      const untagged = 'Feature: F\n  Scenario: S\n    Given x\n'
      const tagged = 'Feature: F\n  @flaky\n  Scenario: S\n    Given x\n'
      const hashOf = (source: string) => parse(source).scenarios[0]!.hash
      expect(hashOf(tagged)).not.toBe(hashOf(untagged))
    })
  })

  it('reports a syntax error with the file name', () => {
    expect(() => parse('Feature: a\n  Scenario: s\n    Given x:\n      | a | b |\n      | 1 |\n')).toThrow(FeatureParseError)
    expect(() => parse('# only a comment\n')).toThrow(/no Feature/)
  })
})
