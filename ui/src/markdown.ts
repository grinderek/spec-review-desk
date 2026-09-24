// A small, safe Markdown reader for agent answers: it produces a block tree, never HTML.
// Supported: paragraphs, `-`/`*`/`1.` lists, `#` headings, fenced code, tables (kept monospace),
// **bold**, `code`.

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string }
export type Block =
  | { kind: 'p'; inlines: Inline[] }
  | { kind: 'h'; level: number; inlines: Inline[] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'code'; text: string }

export function parseInline(text: string): Inline[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part): Inline => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return { kind: 'code', text: part.slice(1, -1) }
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return { kind: 'bold', text: part.slice(2, -2) }
      return { kind: 'text', text: part }
    })
}

const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'p', inlines: parseInline(paragraph.join(' ')) })
    if (list) blocks.push({ kind: list.kind, items: list.items.map(parseInline) })
    paragraph = []
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().startsWith('```')) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith('```'); i++) body.push(lines[i]!)
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (line.trim().startsWith('|')) {
      flush()
      const rows: string[] = []
      for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(lines[i]!.trim())
      i--
      blocks.push({ kind: 'code', text: rows.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', level: heading[1]!.length, inlines: parseInline(heading[2]!) })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    const item = bullet ?? numbered
    if (item) {
      const kind = bullet ? 'ul' : 'ol'
      if (paragraph.length || (list && list.kind !== kind)) flush()
      list = list ?? { kind, items: [] }
      list.items.push(item[1]!)
      continue
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    if (list) flush()
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}
