import { describe, expect, it } from 'vitest'
import { makeClassifier, parseCatalog, splitRow } from './catalog.ts'
import { NEW_STEPS_MD, STEPS_MD } from './testing/fixtures.ts'

describe('splitRow', () => {
  it('keeps pipes inside backticks and escaped pipes inside their cell', () => {
    expect(splitRow('| `the response includes:` (table) | a row `| field | value |` per field |'))
      .toEqual(['`the response includes:` (table)', 'a row `| field | value |` per field'])
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })
})

describe('parseCatalog', () => {
  it('reads phrases with their keyword, meaning and usage note', () => {
    const catalog = parseCatalog(STEPS_MD)
    expect(catalog.preamble).toContain('Every phrase a `.feature` may use.')
    expect(catalog.phrases.map((p) => [p.keyword, p.phrase])).toEqual([
      ['Given', 'a founder in time zone {string}'],
      ['Given', "it is {string} in the founder's time zone"],
      ['When', 'Gmail finished syncing at {string}'],
      ['Then', 'the response includes:'],
    ])
    expect(catalog.phrases[3]).toMatchObject({ note: '(table)', meaning: 'Compares the listed fields; a table row `| field | value |` per field.' })
  })

  it('reads the meaning-extension table as extensions', () => {
    const phrases = parseCatalog(NEW_STEPS_MD).phrases
    expect(phrases.map((p) => [p.kind, p.key])).toEqual([
      ['extension', 'Gmail finished syncing at {string}#extension'],
      ['phrase', "the/another founder's mailbox holds these threads:"],
      ['phrase', "the founder's inbox read lists {int} message(s)"],
    ])
    expect(phrases[1]!.note).toBe('(table `from`, `arrived`)')
  })

  it('records a compile error instead of throwing', () => {
    const [phrase] = parseCatalog('## Given\n\n| Phrase | Meaning |\n|---|---|\n| `a {thing}` | x |\n').phrases
    expect(phrase!.compileError).toMatch(/thing/)
  })

  it('changes a phrase hash when its meaning changes', () => {
    const before = parseCatalog(STEPS_MD).phrases[0]!.hash
    const after = parseCatalog(STEPS_MD.replace('A founder account', 'One founder account')).phrases[0]!.hash
    expect(after).not.toBe(before)
  })
})

describe('makeClassifier', () => {
  const classify = makeClassifier(parseCatalog(STEPS_MD), parseCatalog(NEW_STEPS_MD))

  it('marks catalog, new and uncatalogued steps', () => {
    expect(classify('a founder in time zone "America/New_York"')).toEqual({ kind: 'catalog', phrase: 'a founder in time zone {string}', extended: false })
    expect(classify("the founder's mailbox holds these threads:")).toMatchObject({ kind: 'new' })
    expect(classify("another founder's mailbox holds these threads:")).toMatchObject({ kind: 'new' })
    expect(classify("the founder's inbox read lists 1 message")).toMatchObject({ kind: 'new' })
    expect(classify('something nobody wrote down')).toEqual({ kind: 'uncatalogued', phrase: null, extended: false })
  })

  it('flags a catalog phrase whose meaning this change extends', () => {
    expect(classify('Gmail finished syncing at "2026-09-22 13:50"')).toEqual({ kind: 'catalog', phrase: 'Gmail finished syncing at {string}', extended: true })
  })
})
