import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { addDecisions, decideDecision, dismissDecision, findDecision, ownerDecision } from './decision-model.ts'
import { buildQuestionPrompt, buildResumePrompt, decisionsSection } from './prompt.ts'
import { emptyReview } from './review-store.ts'

describe('buildQuestionPrompt', () => {
  it('names the change, quotes the anchor, lists the files and replays the thread', () => {
    const prompt = buildQuestionPrompt({
      changeName: 'add-thread-state',
      relDir: 'openspec/changes/add-thread-state',
      anchor: { kind: 'scenario', ref: 'features/x.feature::A title', text: 'Scenario: A title\n  Given x' },
      messages: [
        { role: 'owner', at: '2026-09-23T10:00:00Z', text: 'Why 97?', note: null, patch: null },
        { role: 'agent', at: '2026-09-23T10:01:00Z', text: 'Because B = 1.', note: null, patch: null },
        { role: 'owner', at: '2026-09-23T10:02:00Z', text: 'And for B = 2?', note: null, patch: null },
      ],
      files: ['openspec/changes/add-thread-state/features/x.feature', 'features/STEPS.md'],
      today: '2026-09-23',
    })
    expect(prompt).toContain('Change: add-thread-state (directory openspec/changes/add-thread-state/). Today is 2026-09-23.')
    expect(prompt).toContain('## Scenario: features/x.feature::A title')
    expect(prompt).toContain('Scenario: A title\n  Given x')
    expect(prompt).toContain('- features/STEPS.md')
    expect(prompt.indexOf('Why 97?')).toBeLessThan(prompt.indexOf('And for B = 2?'))
    expect(prompt.trimEnd().endsWith('Answer the last OWNER message.')).toBe(true)
  })
})

const AT = '2026-09-24T10:00:00.000Z'
const weight = ownerDecision(
  {
    question: 'Weight for CC threads?',
    scope: { kind: 'scenario', key: 'features/x.feature::A title' },
    blocking: true,
    options: [{ id: 'zero', label: 'Zero', consequence: 'CC threads never count.' }, { id: 'half', label: 'Half', consequence: 'CC threads count half.' }],
  },
  AT,
  () => 'd_00000001',
)
const flag = ownerDecision({ question: 'Ship behind a flag?', scope: { kind: 'change' }, blocking: false, options: [] }, AT, () => 'd_00000002')

describe('decisionsSection', () => {
  it('lists open and decided decisions with scope and choice, never closed ones', () => {
    const doc = decideDecision(addDecisions(emptyReview(), [weight, flag]), 'd_00000002', { option: null, note: 'Yes.' }, AT)
    expect(decisionsSection(doc.decisions)).toEqual([
      '## Decisions',
      '- d_00000001 [open, blocking] scenario features/x.feature::A title — Weight for CC threads?\n  Options: zero, half',
      "- d_00000002 [decided] the whole change — Ship behind a flag?\n  Owner's choice: no option; note: Yes.",
    ])
    const closed = dismissDecision(doc, 'd_00000001', 'x', AT).decisions.filter((d) => d.status !== 'decided')
    expect(decisionsSection(closed)).toEqual(['## Decisions', 'No open or decided decisions.'])
  })

  it('goes into the question prompt before the thread', () => {
    const prompt = buildQuestionPrompt({
      changeName: 'c', relDir: 'openspec/changes/c', anchor: { kind: 'change', ref: '', text: 'x' },
      messages: [{ role: 'owner', at: AT, text: 'Hi?', note: null, patch: null }], files: [], today: '2026-09-24', decisions: [weight],
    })
    expect(prompt).toContain('## Decisions\n- d_00000001 [open, blocking]')
    expect(prompt.indexOf('## Decisions')).toBeLessThan(prompt.indexOf('## Thread so far'))
  })
})

describe('buildResumePrompt', () => {
  it('lists every decision of the run with its outcome', () => {
    const decided = decideDecision(addDecisions(emptyReview(), [weight, flag]), 'd_00000001', { option: 'zero', note: 'CC is noise.' }, AT)
    const recorded = { ...findDecision(decided, 'd_00000001'), status: 'recorded' as const, recorded: { how: 'patch' as const, commit: 'abc1234' } }
    const dismissed = findDecision(dismissDecision(decided, 'd_00000002', 'Out of scope.', AT), 'd_00000002')
    expect(buildResumePrompt([recorded, dismissed])).toBe([
      'The owner answered the decisions you raised:',
      '- d_00000001 (Weight for CC threads?): Zero — CC threads never count. Note: CC is noise. Recorded in the scenario by abc1234.',
      '- d_00000002 (Ship behind a flag?): dismissed — Out of scope.',
      '',
      'Continue the apply with these choices.',
    ].join('\n'))
  })
})

describe('agent rules', () => {
  const rules = async (name: string): Promise<string> =>
    (await readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8')).replace(/\s+/g, ' ')
  const RULE = "A question only the owner can answer goes into `decisions[]` with 2–4 options and your recommendation — never into prose. Scope it to a scenario key when it changes a scenario's behavior, else to the change."

  it('both agents raise owner questions as decisions, never in prose', async () => {
    expect(await rules('reviewer.md')).toContain(RULE)
    expect(await rules('apply.md')).toContain(RULE)
  })

  it('drops the prose channels of v1', async () => {
    expect(await rules('reviewer.md')).not.toContain('fenced block tagged `diff`')
    expect(await rules('apply.md')).not.toContain('NEEDS_OWNER')
  })
})
