import { describe, expect, it } from 'vitest'
import type { StepKeyword, StepView } from './gherkin.ts'
import { effectiveKeywords, scenarioShape } from './shape.ts'

let line = 0
const step = (keyword: string, text: string, over: Partial<Pick<StepView, 'catalogKeyword' | 'event'>> = {}): StepView => ({
  keyword,
  text,
  line: ++line,
  kind: 'catalog',
  phrase: text,
  extended: false,
  catalogKeyword: null,
  event: null,
  table: null,
  docString: null,
  ...over,
})
const ev = (keyword: StepKeyword, text: string, event: string): StepView => step(keyword, text, { catalogKeyword: keyword, event })

describe('effectiveKeywords', () => {
  it('lets And, But and * continue the previous primary keyword', () => {
    const steps = [step('Given', 'a'), step('And', 'b'), step('When', 'c'), step('*', 'd'), step('Then', 'e'), step('But', 'f')]
    expect(effectiveKeywords(steps)).toEqual(['Given', 'Given', 'When', 'When', 'Then', 'Then'])
    expect(effectiveKeywords([step('And', 'a')])).toEqual([null])
    expect(effectiveKeywords([step('And', 'a')], 'Given')).toEqual(['Given'])
  })
})

describe('scenarioShape', () => {
  it('collects the Given events, the When command and the Then events, deduplicated, background first', () => {
    const background = [ev('Given', 'a founder', 'FounderRegistered')]
    const steps = [
      ev('Given', 'a mailbox', 'MailboxSynced'),
      step('And', 'a clock'),
      ev('Given', 'another mailbox', 'MailboxSynced'),
      ev('When', 'a sync', 'SyncGmail'),
      ev('Then', 'the inbox is scored', 'InboxScored'),
      step('And', 'the page shows it', { catalogKeyword: 'Then', event: 'InboxRead' }),
    ]
    expect(scenarioShape(background, steps)).toEqual({
      given: ['FounderRegistered', 'MailboxSynced'],
      when: ['SyncGmail'],
      then: ['InboxScored', 'InboxRead'],
      warnings: [],
    })
  })

  it('accepts a scenario whose And steps continue the keyword and whose catalog keywords match', () => {
    const steps = [ev('Given', 'a', 'A'), step('And', 'b', { catalogKeyword: 'Given' }), ev('When', 'c', 'C'), ev('Then', 'd', 'D'), step('But', 'e', { catalogKeyword: 'Then' })]
    expect(scenarioShape([], steps).warnings).toEqual([])
  })

  it('wants exactly one When and at least one Then', () => {
    expect(scenarioShape([], [step('Given', 'a'), step('Then', 'b')]).warnings).toEqual(['no When step — a scenario sends exactly one command or request'])
    line = 10
    const two = [step('Given', 'a'), step('When', 'b'), step('When', 'c'), step('Then', 'd')]
    expect(scenarioShape([], two).warnings).toEqual(['2 When steps (line 12, line 13) — one command or request per scenario'])
    expect(scenarioShape([], [step('Given', 'a'), step('When', 'b')]).warnings).toEqual(['no Then step — nothing is expected of the command'])
  })

  it('reports preconditions after the command and a command after the expectations', () => {
    line = 0
    const steps = [step('When', 'a'), step('Given', 'b'), step('Then', 'c'), step('When', 'd')]
    expect(scenarioShape([], steps).warnings).toEqual([
      '2 When steps (line 1, line 4) — one command or request per scenario',
      'Given after When (line 2) — every precondition is an event before the command',
      'When after Then (line 4) — a second command belongs in its own scenario',
    ])
  })

  it('reports a step used under another keyword than its catalog section', () => {
    line = 0
    const steps = [step('Given', 'a', { catalogKeyword: 'Given' }), step('When', 'the page is read', { catalogKeyword: 'Then' }), step('Then', 'c', { catalogKeyword: 'Then' })]
    expect(scenarioShape([], steps).warnings).toEqual(['line 2: "the page is read" is a Then phrase in the catalog, used as When'])
  })

  it('reports a scenario that starts with And when no background sets the keyword', () => {
    line = 0
    const steps = [step('And', 'a'), step('When', 'b'), step('Then', 'c')]
    expect(scenarioShape([], steps).warnings).toEqual(['starts with And (line 1) — the first step must be Given, When or Then'])
    expect(scenarioShape([step('Given', 'bg')], steps).warnings).toEqual([])
  })

  it('counts a When in the Background as the scenario command', () => {
    line = 0
    const background = [step('Given', 'a'), step('When', 'b')]
    expect(scenarioShape(background, [step('Then', 'c')]).warnings).toEqual([])
    expect(scenarioShape(background, [step('When', 'd'), step('Then', 'e')]).warnings).toEqual(['2 When steps (line 2, line 4) — one command or request per scenario'])
  })
})
