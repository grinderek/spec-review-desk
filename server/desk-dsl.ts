import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { FeatureParseError, type FeatureView, type StepView } from './gherkin.ts'

const Name = /^[A-Z][A-Za-z0-9]+$/
const Fact = z.record(z.string().regex(Name), z.record(z.string(), z.unknown())).refine((v) => Object.keys(v).length === 1, 'exactly one named event or command is required')
const Scenario = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  scenario: z.string().min(1),
  given: z.array(Fact),
  when: Fact,
  then: z.object({ events: z.array(Fact), response: z.object({ status: z.number().int().min(100).max(599), body: z.unknown().optional() }).strict() }).strict(),
}).strict()
export const DeskDslSchema = z.object({ version: z.literal(1), feature: z.string().min(1), scenarios: z.array(Scenario).min(1) }).strict()
export type DeskScenario = z.infer<typeof Scenario>
export type Fact = z.infer<typeof Fact>
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)])) : v
export function contractHash(scenario: DeskScenario): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(scenario))).digest('hex')}`
}
export function parseDeskDsl(source: string, file: string): z.infer<typeof DeskDslSchema> {
  try {
    const yaml = parseDocument(source, { uniqueKeys: true })
    if (yaml.errors.length) throw yaml.errors[0]
    const doc = DeskDslSchema.parse(yaml.toJS({ maxAliasCount: 0 }))
    if (new Set(doc.scenarios.map((s) => s.id)).size !== doc.scenarios.length) throw new Error('duplicate scenario id')
    return doc
  } catch (error) { throw new FeatureParseError(file, error instanceof Error ? error.message : String(error)) }
}
export function deskFeature(source: string, file: string): FeatureView {
  const doc = parseDeskDsl(source, file)
  const step = (keyword: string, event: Fact): StepView => ({ keyword, text: Object.keys(event)[0]!, line: 1, kind: 'catalog', phrase: null, extended: false, catalogKeyword: null, event: Object.keys(event)[0]!, table: null, docString: stringify(Object.values(event)[0]) })
  return { file, name: doc.feature, tags: ['desk-dsl'], description: 'Desk DSL v1', preamble: [], background: [], scenarios: doc.scenarios.map((s) => ({
    key: `${file}::${s.id}`, file, title: s.scenario, kind: 'Scenario', line: 1, tags: ['desk-dsl'], decisions: [], notes: [], examples: [],
    source: stringify(s), hash: contractHash(s),
    steps: [...s.given.map((e) => step('Given', e)), step('When', s.when), ...s.then.events.map((e) => step('Then', e)), { ...step('Then', { Response: s.then.response }), event: null }].map((step, i) => ({ ...step, line: i + 1 })),
    shape: { given: s.given.map((e) => Object.keys(e)[0]!), when: Object.keys(s.when), then: s.then.events.map((e) => Object.keys(e)[0]!), warnings: [] },
  })) }
}
