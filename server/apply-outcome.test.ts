import { describe, expect, it } from 'vitest'
import { logText, outcomeOf } from './apply-outcome.ts'
import type { CodexEvent, ResultEvent } from './codex.ts'

const result = (over: Partial<ResultEvent>): CodexEvent[] => [{ type: 'result', ok: true, text: '', numTurns: 2, sessionId: 's', ...over }]
const reply = { answer: 'Blocked.', patch: null, decisions: [], resolves: [], status: 'needs_owner' }

describe('outcomeOf', () => {
  it('maps a structured status to the run outcome', () => {
    expect(outcomeOf(result({ structured: reply, text: JSON.stringify(reply) }), false)).toMatchObject({
      outcome: 'needs_owner', text: 'Blocked.', reply: { status: 'needs_owner' }, issues: [],
    })
    expect(outcomeOf(result({ text: JSON.stringify({ ...reply, status: 'done' }) }), false).outcome).toBe('done')
    expect(outcomeOf(result({ structured: { ...reply, status: 'failed' } }), false).outcome).toBe('failed')
    expect(outcomeOf(result({ structured: { ...reply, status: 'answered' } }), false).outcome).toBe('failed')
  })

  it('reports a schema-invalid object as failed with its issues', () => {
    const broken = outcomeOf(result({ structured: { answer: 1 } }), false)
    expect(broken).toMatchObject({ outcome: 'failed', reply: null, raw: expect.stringContaining('"answer": 1') })
    expect(broken.issues[0]).toMatch(/^answer:/)
  })

  it('keeps the v1 prose rule when there is no structured object', () => {
    expect(outcomeOf(result({ text: 'Stuck.\nNEEDS_OWNER: which?' }), false)).toMatchObject({ outcome: 'needs_owner', reply: null, issues: [] })
    expect(outcomeOf(result({ text: 'All green.' }), false).outcome).toBe('done')
    expect(outcomeOf(result({ structured: reply }), true).outcome).toBe('stopped')
  })
})

describe('logText', () => {
  it('shows the narration plus the structured answer', () => {
    const events: CodexEvent[] = [{ type: 'delta', text: 'Reading.' }, ...result({ structured: { ...reply, answer: 'Done.', status: 'done' } })]
    expect(logText(events)).toBe('Reading.\n\nDone.')
    expect(logText([{ type: 'delta', text: 'hi' }])).toBe('hi')
  })
})
