import { describe, expect, it } from 'vitest'
import { splitComments, stripCommentMarker } from './decisions.ts'

const lines = (start: number, texts: string[]) => texts.map((text, i) => ({ line: start + i, text }))

describe('stripCommentMarker', () => {
  it('drops indentation, the hash and one space', () => {
    expect(stripCommentMarker('  # Owner decision')).toBe('Owner decision')
    expect(stripCommentMarker('#tight')).toBe('tight')
  })
})

describe('splitComments', () => {
  it('reads a decision and its continuation lines until an empty comment line', () => {
    const result = splitComments(lines(10, [
      'The replied thread is not a candidate.',
      'Owner decision 2026-09-23: ONE reason, resolved, for the ball',
      'not being in the founder court.',
      '',
      'A trailing note.',
    ]))
    expect(result.notes).toEqual(['The replied thread is not a candidate.', 'A trailing note.'])
    expect(result.decisions).toEqual([{
      date: '2026-09-23', tag: null, line: 11, commit: null,
      anchor: 'Owner decision 2026-09-23: ONE reason, resolved, for the ball',
      text: 'ONE reason, resolved, for the ball not being in the founder court.',
    }])
  })

  it('reads the option tag', () => {
    const [decision] = splitComments(lines(1, ['Owner decision 2026-09-23 (B): the wait starts at the first message.'])).decisions
    expect(decision).toMatchObject({ tag: 'B', text: 'the wait starts at the first message.' })
  })

  it('splits a decision that starts mid-line from the note before it', () => {
    const result = splitComments(lines(1, ['(client contract §4.1); owner decision 2026-09-23: importance is checked first']))
    expect(result.notes).toEqual(['(client contract §4.1);'])
    expect(result.decisions[0]!.text).toBe('importance is checked first')
  })

  it('treats a gap in line numbers as a paragraph break', () => {
    const result = splitComments([{ line: 1, text: 'first' }, { line: 5, text: 'second' }])
    expect(result.notes).toEqual(['first', 'second'])
  })
})
