export interface CommentLine { line: number; text: string }

export interface Decision {
  date: string
  tag: string | null
  text: string
  anchor: string
  line: number
  commit: string | null
}

const DECISION = /\bowner decision (\d{4}-\d{2}-\d{2})(?: \(([^)]+)\))?:\s*/i

export function stripCommentMarker(raw: string): string {
  return raw.trim().replace(/^#\s?/, '')
}

interface OpenDecision { date: string; tag: string | null; line: number; anchor: string }

export function splitComments(lines: readonly CommentLine[]): { decisions: Decision[]; notes: string[] } {
  const decisions: Decision[] = []
  const notes: string[] = []
  let buffer: string[] = []
  let open: OpenDecision | null = null
  let previousLine = -1

  const flush = (): void => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim()
    const current: OpenDecision | null = open
    if (text && current) decisions.push({ ...current, text, commit: null })
    else if (text) notes.push(text)
    buffer = []
    open = null
  }

  for (const { line, text } of lines) {
    if (previousLine !== -1 && line !== previousLine + 1) flush()
    previousLine = line
    if (text.trim() === '') {
      flush()
      continue
    }
    const match = DECISION.exec(text)
    if (match) {
      const before = text.slice(0, match.index).trim()
      if (before) buffer.push(before)
      flush()
      open = { date: match[1]!, tag: match[2] ?? null, line, anchor: text.trim() }
      buffer.push(text.slice(match.index + match[0].length))
      continue
    }
    buffer.push(text.trim())
  }
  flush()
  return { decisions, notes }
}
