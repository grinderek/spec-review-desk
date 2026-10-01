import { describe, expect, it } from 'vitest'
import { AnswerReader, StructuredStream } from './answer-reader.ts'
import type { CodexEvent } from './codex.ts'

const chunks = (text: string, size: number): string[] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))

function read(parts: readonly string[]): { out: string[]; reader: AnswerReader } {
  const reader = new AnswerReader()
  return { out: parts.map((p) => reader.push(p)), reader }
}

describe('AnswerReader', () => {
  it('decodes the answer identically for every chunk size, emoji and escapes included', () => {
    const answer = 'Line 1\nsays "hi" \\ tab\t / ü € 😀 end'
    const json = JSON.stringify({ patch: null, answer, decisions: [] })
    for (let size = 1; size <= 9; size++) {
      const { out, reader } = read(chunks(json, size))
      expect(out.join('')).toBe(answer)
      expect(reader.text).toBe(answer)
      expect(reader.done).toBe(true)
    }
  })

  it('decodes \\u escapes, surrogate pairs included, across chunk boundaries', () => {
    const json = '{"answer":"caf\\u00e9 \\ud83d\\ude00 \\/ ok","status":"answered"}'
    for (let size = 1; size <= 8; size++) expect(read(chunks(json, size)).out.join('')).toBe('café 😀 / ok')
  })

  it('never emits half of a surrogate pair', () => {
    const reader = new AnswerReader()
    expect(reader.push('{"answer":"a\uD83D')).toBe('a')
    expect(reader.push('\uDE00b"}')).toBe('😀b')
  })

  it('reads only the top-level answer key', () => {
    const json = '{"patch":"\\"answer\\":\\"no\\"","decisions":[{"answer":"nested","x":{"answer":"deep"}}],"answer":"yes","resolves":[]}'
    expect(read(chunks(json, 3)).out.join('')).toBe('yes')
  })

  it('streams a growing prefix and stops at the closing quote', () => {
    const reader = new AnswerReader()
    expect(reader.push('{"answer":"Hel')).toBe('Hel')
    expect(reader.push('lo", "answer": "again"}')).toBe('lo')
    expect(reader.done).toBe(true)
    expect(reader.push('more')).toBe('')
  })

  it('ignores a null answer', () => {
    const { out, reader } = read(['{"answer":null,"patch":"x"}'])
    expect(out.join('')).toBe('')
    expect(reader.done).toBe(false)
  })
})

describe('StructuredStream', () => {
  const feedAll = (events: CodexEvent[]): CodexEvent[] => {
    const stream = new StructuredStream()
    return events.flatMap((e) => stream.feed(e))
  }

  it('emits the answer of the StructuredOutput call only — never text, thinking or another tool input', () => {
    expect(feedAll([
      { type: 'message_start' },
      { type: 'delta', text: 'Reading the change.' },
      { type: 'tool_start', index: 1, name: 'Read' },
      { type: 'json_delta', index: 1, json: '{"file_path":"x","answer":"not this"}' },
      { type: 'message_start' },
      { type: 'tool_start', index: 1, name: 'StructuredOutput' },
      { type: 'json_delta', index: 1, json: '{"answer":"Yes' },
      { type: 'json_delta', index: 1, json: ', because."}' },
    ])).toEqual([{ type: 'answer_delta', text: 'Yes' }, { type: 'answer_delta', text: ', because.' }])
  })

  it('ignores json deltas of another block index in the same message', () => {
    expect(feedAll([
      { type: 'message_start' },
      { type: 'tool_start', index: 0, name: 'Grep' },
      { type: 'tool_start', index: 1, name: 'StructuredOutput' },
      { type: 'json_delta', index: 0, json: '{"answer":"grep"}' },
      { type: 'json_delta', index: 1, json: '{"answer":"real"}' },
    ])).toEqual([{ type: 'answer_delta', text: 'real' }])
  })

  it('resets when a second StructuredOutput call starts after text was emitted', () => {
    expect(feedAll([
      { type: 'tool_start', index: 0, name: 'StructuredOutput' },
      { type: 'json_delta', index: 0, json: '{"answer":"first"}' },
      { type: 'message_start' },
      { type: 'tool_start', index: 0, name: 'StructuredOutput' },
      { type: 'json_delta', index: 0, json: '{"answer":"second"}' },
    ])).toEqual([{ type: 'answer_delta', text: 'first' }, { type: 'answer_reset' }, { type: 'answer_delta', text: 'second' }])
  })
})
