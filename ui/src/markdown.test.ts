import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown.ts'

describe('parseMarkdown', () => {
  it('reads paragraphs, lists, headings, code and inline marks without producing HTML', () => {
    const blocks = parseMarkdown('Intro **bold** and `code`.\nsame paragraph\n\n- **one** — a\n  continued\n- two\n\n1. first\n2. second\n\n## Title\n```\nraw <b>\n```\n<script>x</script>')
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'ul', 'ol', 'h', 'code', 'p'])
    expect(blocks[0]).toEqual({ kind: 'p', inlines: [
      { kind: 'text', text: 'Intro ' }, { kind: 'bold', text: 'bold' }, { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' }, { kind: 'text', text: '. same paragraph' },
    ] })
    expect(blocks[1]).toMatchObject({ kind: 'ul', items: [[{ kind: 'bold', text: 'one' }, { kind: 'text', text: ' — a continued' }], [{ kind: 'text', text: 'two' }]] })
    expect(blocks[4]).toEqual({ kind: 'code', text: 'raw <b>' })
    expect(blocks[5]).toEqual({ kind: 'p', inlines: [{ kind: 'text', text: '<script>x</script>' }] })
  })

  it('keeps table rows together as a monospace block', () => {
    expect(parseMarkdown('Before\n| a | b |\n|---|---|\n| 1 | 2 |\nAfter')).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'Before' }] },
      { kind: 'code', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
      { kind: 'p', inlines: [{ kind: 'text', text: 'After' }] },
    ])
  })

  it('leaves unmatched markers as text', () => {
    expect(parseInline('a ** b ` c')).toEqual([{ kind: 'text', text: 'a ** b ` c' }])
  })
})
