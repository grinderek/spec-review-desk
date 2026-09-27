import { describe, expect, it } from 'vitest'
import { AnswerReader } from './answer-reader.ts'

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
