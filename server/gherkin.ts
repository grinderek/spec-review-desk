import { createHash } from 'node:crypto'
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin'
import { IdGenerator } from '@cucumber/messages'
import type { Background, DataTable, DocString, Examples, FeatureChild, GherkinDocument, Scenario, Step, Tag } from '@cucumber/messages'
import { type CommentLine, type Decision, splitComments, stripCommentMarker } from './decisions.ts'
import { type ScenarioShape, scenarioShape } from './shape.ts'

export type StepKind = 'catalog' | 'new' | 'uncatalogued'
export type StepKeyword = 'Given' | 'When' | 'Then'
export interface Classification {
  kind: StepKind
  phrase: string | null
  extended: boolean
  // The catalog section the matched phrase sits under, and its Event/Command column (catalog.ts).
  keyword: StepKeyword | null
  event: string | null
}
export type Classify = (text: string) => Classification
export const unclassified: Classify = () => ({ kind: 'uncatalogued', phrase: null, extended: false, keyword: null, event: null })

export interface StepView {
  keyword: string
  text: string
  line: number
  kind: StepKind
  phrase: string | null
  extended: boolean
  catalogKeyword: StepKeyword | null
  event: string | null
  table: string[][] | null
  docString: string | null
}
export interface ExamplesView { name: string; header: string[]; rows: string[][] }
export interface ScenarioView {
  key: string
  file: string
  title: string
  kind: 'Scenario' | 'Scenario Outline'
  line: number
  tags: string[]
  decisions: Decision[]
  notes: string[]
  steps: StepView[]
  examples: ExamplesView[]
  shape: ScenarioShape
  source: string
  hash: string
}
export interface FeatureView {
  file: string
  name: string
  tags: string[]
  description: string
  preamble: string[]
  background: StepView[]
  scenarios: ScenarioView[]
}

export class FeatureParseError extends Error {
  constructor(readonly file: string, message: string) {
    super(`${file}: ${message}`)
  }
}

export const scenarioKey = (file: string, title: string): string => `${file}::${title}`

type Node = Background | Scenario
const isScenario = (node: Node): node is Scenario => 'examples' in node

const tableRows = (table: DataTable | undefined): string[][] | null =>
  table ? table.rows.map((row) => row.cells.map((cell) => cell.value)) : null

const docStringEnd = (doc: DocString): number => doc.location.line + doc.content.split('\n').length + 1

function stepEnd(step: Step): number {
  const rows = step.dataTable?.rows ?? []
  const lastRow = rows.length ? rows[rows.length - 1]!.location.line : step.location.line
  return Math.max(lastRow, step.docString ? docStringEnd(step.docString) : 0)
}

function examplesEnd(examples: Examples): number {
  const rows = examples.tableBody.length ? examples.tableBody : examples.tableHeader ? [examples.tableHeader] : []
  return rows.length ? rows[rows.length - 1]!.location.line : examples.location.line
}

function nodeStart(node: Node): number {
  const tags: readonly Tag[] = isScenario(node) ? node.tags : []
  return Math.min(node.location.line, ...tags.map((t) => t.location.line))
}

function nodeEnd(node: Node): number {
  const examples = isScenario(node) ? node.examples.map(examplesEnd) : []
  return Math.max(node.location.line, ...node.steps.map(stepEnd), ...examples)
}

function flatten(children: readonly FeatureChild[]): Node[] {
  return children.flatMap((child): Node[] => {
    if (child.background) return [child.background]
    if (child.scenario) return [child.scenario]
    if (child.rule) {
      return child.rule.children.flatMap((c): Node[] => (c.background ? [c.background] : c.scenario ? [c.scenario] : []))
    }
    return []
  })
}

function substitute(text: string, header: readonly string[], row: readonly string[] | undefined): string {
  if (!row) return text
  return header.reduce((acc, name, i) => acc.split(`<${name}>`).join(row[i] ?? ''), text)
}

function stepView(step: Step, classify: Classify, sample: (text: string) => string): StepView {
  const c = classify(sample(step.text))
  return {
    keyword: step.keyword.trim(),
    text: step.text,
    line: step.location.line,
    kind: c.kind,
    phrase: c.phrase,
    extended: c.extended,
    catalogKeyword: c.keyword,
    event: c.event,
    table: tableRows(step.dataTable),
    docString: step.docString?.content ?? null,
  }
}

const canonStep = (s: StepView) => [s.keyword, s.text, s.table, s.docString]
const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

export function parseFeature(source: string, file: string, classify: Classify): FeatureView {
  let doc: GherkinDocument
  try {
    doc = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher()).parse(source)
  } catch (error) {
    throw new FeatureParseError(file, (error as Error).message)
  }
  const feature = doc.feature
  if (!feature) throw new FeatureParseError(file, 'no Feature: line')

  const lines = source.split(/\r?\n/)
  const comments: CommentLine[] = doc.comments.map((c) => ({ line: c.location.line, text: stripCommentMarker(c.text) }))
  const nodes = flatten(feature.children)
  const firstStart = nodes.length ? nodeStart(nodes[0]!) : Number.MAX_SAFE_INTEGER
  const preamble = splitComments(comments.filter((c) => c.line > feature.location.line && c.line < firstStart)).notes
  const backgroundNode = nodes.find((n) => !isScenario(n))
  const background = (backgroundNode?.steps ?? []).map((s) => stepView(s, classify, (t) => t))

  const scenarios = nodes.flatMap((node, index): ScenarioView[] => {
    if (!isScenario(node)) return []
    const lower = index === 0 ? feature.location.line : nodeEnd(nodes[index - 1]!)
    const start = nodeStart(node)
    const attached = comments.filter((c) => c.line > lower && c.line < start)
    const { decisions, notes } = splitComments(attached)
    const examples: ExamplesView[] = node.examples.map((e) => ({
      name: e.name,
      header: e.tableHeader?.cells.map((c) => c.value) ?? [],
      rows: e.tableBody.map((r) => r.cells.map((c) => c.value)),
    }))
    const first = examples[0]
    const steps = node.steps.map((s) => stepView(s, classify, (t) => substitute(t, first?.header ?? [], first?.rows[0])))
    const title = node.name.trim()
    const keyword = node.keyword.trim()
    const kind = keyword === 'Scenario Outline' || keyword === 'Scenario Template' ? 'Scenario Outline' : 'Scenario'
    const tags = node.tags.map((t) => t.name)
    const blockStart = attached.length ? attached[0]!.line : start
    return [{
      key: scenarioKey(file, title),
      file,
      title,
      kind,
      line: node.location.line,
      tags,
      decisions,
      notes,
      steps,
      examples,
      shape: scenarioShape(background, steps),
      source: lines.slice(blockStart - 1, nodeEnd(node)).join('\n'),
      hash: sha256({
        background: background.map(canonStep),
        comments: attached.map((c) => c.text.trim()),
        kind,
        title,
        tags,
        steps: steps.map(canonStep),
        examples,
      }),
    }]
  })

  return {
    file,
    name: feature.name.trim(),
    tags: feature.tags.map((t) => t.name),
    description: feature.description.trim(),
    preamble,
    background,
    scenarios,
  }
}
