import { describe, expect, it } from 'vitest'
import { buildQuestionPrompt } from './prompt.ts'

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
