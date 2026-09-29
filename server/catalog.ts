import { createHash } from 'node:crypto'
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions'
import type { Classification, Classify, StepKeyword } from './gherkin.ts'

export type { StepKeyword } from './gherkin.ts'
export interface Phrase {
  key: string
  phrase: string
  keyword: StepKeyword | null
  meaning: string
  note: string
  kind: 'phrase' | 'extension'
  // The event-sourcing column (docs/method/bdd-event-sourcing.md): under Given and Then the event
  // the phrase appends to / expects in the stream, under When the command or request it sends.
  // Null when the catalog table has no such column or the cell is empty.
  event: string | null
  hash: string
  compileError: string | null
}
export interface Catalog { preamble: string; phrases: Phrase[] }

export const emptyCatalog = (): Catalog => ({ preamble: '', phrases: [] })

const SEPARATOR = /^\|\s*:?-{3,}/
const registry = new ParameterTypeRegistry()

export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inTick = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (ch === '`') inTick = !inTick
    if (ch === '|' && !inTick) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  return cells
}

function compile(phrase: string): { expression: CucumberExpression | null; error: string | null } {
  try {
    return { expression: new CucumberExpression(phrase, registry), error: null }
  } catch (error) {
    return { expression: null, error: (error as Error).message.replace(/\s+/g, ' ').trim() }
  }
}

const hashOf = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

export function parseCatalog(markdown: string): Catalog {
  const lines = markdown.split(/\r?\n/)
  const firstSection = lines.findIndex((l) => l.startsWith('## '))
  const preamble = lines
    .slice(0, firstSection === -1 ? lines.length : firstSection)
    .filter((l) => !l.startsWith('# '))
    .join('\n')
    .trim()
  const phrases: Phrase[] = []
  let keyword: StepKeyword | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      const match = /^(Given|When|Then)\b/.exec(heading[1]!.trim())
      keyword = match ? (match[1] as StepKeyword) : null
      continue
    }
    if (!line.trim().startsWith('|') || !SEPARATOR.test(lines[i + 1]?.trim() ?? '')) continue
    const header = splitRow(line).map((h) => h.toLowerCase())
    const kind: Phrase['kind'] = (header[1] ?? '').includes('extended') ? 'extension' : 'phrase'
    // An optional third column — `Event` (Given/Then) or `Command` (When) — names what the phrase
    // means in the event stream; the Desk shows it as the scenario's Given → When → Then line.
    const eventColumn = header.findIndex((h, index) => index >= 2 && /\b(event|command|request)s?\b/.test(h))
    let j = i + 2
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]!)
      const first = cells[0] ?? ''
      const tick = /`([^`]+)`/.exec(first)
      if (!tick) continue
      const phrase = tick[1]!
      const note = first.slice(tick.index + tick[0].length).trim()
      const meaning = cells[1] ?? ''
      const event = eventColumn === -1 ? null : (cells[eventColumn] ?? '').replace(/`/g, '').trim() || null
      phrases.push({
        key: kind === 'extension' ? `${phrase}#extension` : phrase,
        phrase,
        keyword,
        meaning,
        note,
        kind,
        event,
        hash: hashOf([phrase, meaning, note, kind, event]),
        compileError: compile(phrase).error,
      })
    }
    i = j - 1
  }
  return { preamble, phrases }
}

export function makeClassifier(approved: Catalog, proposed: Catalog): Classify {
  const compiled = (catalog: Catalog) =>
    catalog.phrases
      .filter((p) => p.kind === 'phrase')
      .flatMap((p) => {
        const { expression } = compile(p.phrase)
        return expression ? [{ phrase: p.phrase, keyword: p.keyword, event: p.event, expression }] : []
      })
  const catalog = compiled(approved)
  const fresh = compiled(proposed)
  const extended = new Set(proposed.phrases.filter((p) => p.kind === 'extension').map((p) => p.phrase))
  return (text: string): Classification => {
    const hit = catalog.find((c) => c.expression.match(text) !== null)
    if (hit) return { kind: 'catalog', phrase: hit.phrase, extended: extended.has(hit.phrase), keyword: hit.keyword, event: hit.event }
    const proposedHit = fresh.find((c) => c.expression.match(text) !== null)
    if (proposedHit) return { kind: 'new', phrase: proposedHit.phrase, extended: false, keyword: proposedHit.keyword, event: proposedHit.event }
    return { kind: 'uncatalogued', phrase: null, extended: false, keyword: null, event: null }
  }
}
