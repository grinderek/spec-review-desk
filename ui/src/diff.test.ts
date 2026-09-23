import { describe, expect, it } from 'vitest'
import { lineDiff } from './diff.ts'

describe('lineDiff', () => {
  it('marks added and removed lines around the common ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
  })

  it('treats an empty before as all additions', () => {
    expect(lineDiff('', 'a\nb').map((l) => l.kind)).toEqual(['add', 'add'])
  })
})
