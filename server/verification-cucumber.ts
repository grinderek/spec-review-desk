import { z } from 'zod'
import { corpusKey, parseRunMessages } from './run-messages.ts'
import type { VerificationSource } from './verification-source.ts'
import { CorpusRunSchema } from './verification-events.ts'

const id = z.string().min(1)
const Status = z.enum(['PASSED', 'FAILED', 'UNDEFINED', 'PENDING', 'SKIPPED', 'AMBIGUOUS', 'UNKNOWN'])
const TestCase = z.object({ id, pickleId: id, testSteps: z.array(z.object({ id })) })
const Started = z.object({ id, testCaseId: id, attempt: z.number().int().nonnegative().optional() })
const Finished = z.object({ testCaseStartedId: id, willBeRetried: z.boolean().optional() })
type Record = { [key: string]: unknown }
function unique<T>(values: Map<string, T>, key: string, value: T, label: string): void {
  if (values.has(key)) throw new Error(`Duplicate Cucumber ${label}: ${key}`)
  values.set(key, value)
}

// Cucumber is an external result format. Its freshness comes from the immutable attempt's
// unique output artifact, not from a shared file or a title-based import of older reports.
export function acceptCucumberVerification(envelopes: Record[], source: VerificationSource): z.infer<typeof CorpusRunSchema> {
  const cases = new Map<string, z.infer<typeof TestCase>>()
  const starts = new Map<string, z.infer<typeof Started>>()
  const ends = new Map<string, z.infer<typeof Finished>>()
  const steps = new Map<string, Set<string>>()
  const pickleKeys = new Map<string, string>()
  const scenarioKeys = new Map<string, string>()
  const scenarioRows = new Map<string, string[]>()
  const pickles: { id: string; uri: string; astNodeIds: string[] }[] = []
  let terminal: { success: boolean; timestamp: { seconds: string | number; nanos?: number } } | null = null
  for (const [index, envelope] of envelopes.entries()) {
    if (Object.keys(envelope).length !== 1) throw new Error('Cucumber envelope must contain one message')
    if (envelope.testRunFinished) {
      if (terminal || index !== envelopes.length - 1) throw new Error('Cucumber terminal record must be unique and last')
      terminal = z.object({ success: z.boolean(), timestamp: z.object({ seconds: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]), nanos: z.number().int().nonnegative().max(999_999_999).optional() }) }).parse(envelope.testRunFinished)
    } else if (envelope.testCase) {
      const item = TestCase.parse(envelope.testCase)
      if (new Set(item.testSteps.map(step => step.id)).size !== item.testSteps.length) throw new Error('Duplicate Cucumber test step')
      unique(cases, item.id, item, 'test case')
    } else if (envelope.testCaseStarted) {
      const item = Started.parse(envelope.testCaseStarted); unique(starts, item.id, item, 'test case start')
    } else if (envelope.testCaseFinished) {
      const item = Finished.parse(envelope.testCaseFinished); unique(ends, item.testCaseStartedId, item, 'test case end')
    } else if (envelope.testStepFinished) {
      const item = z.object({ testCaseStartedId: id, testStepId: id, testStepResult: z.object({ status: Status }) }).parse(envelope.testStepFinished)
      const completed = steps.get(item.testCaseStartedId) ?? new Set<string>()
      if (completed.has(item.testStepId)) throw new Error('Duplicate Cucumber step result')
      completed.add(item.testStepId); steps.set(item.testCaseStartedId, completed)
    } else if (envelope.pickle) {
      const item = z.object({ id, uri: id, astNodeIds: z.array(id).min(1) }).parse(envelope.pickle)
      if (pickles.some(pickle => pickle.id === item.id)) throw new Error('Duplicate Cucumber pickle')
      pickles.push(item)
    } else if (envelope.gherkinDocument) {
      const document = z.object({ uri: id, feature: z.object({ children: z.array(z.unknown()) }) }).parse(envelope.gherkinDocument)
      const nodes = (document.feature.children as any[]).flatMap(node => node.rule ? node.rule.children : [node])
      for (const node of nodes) if (node.scenario) {
        const scenario = z.object({ id, name: z.string() }).parse(node.scenario)
        unique(scenarioKeys, scenario.id, corpusKey(document.uri, scenario.name), 'scenario AST id')
        const rows = (node.scenario.examples ?? []).flatMap((example: any) => (example.tableBody ?? []).map((row: any) => id.parse(row.id)))
        if (new Set(rows).size !== rows.length) throw new Error('Duplicate Cucumber example row identity')
        scenarioRows.set(scenario.id, rows)
      }
    } else if (Object.keys(envelope).some(key => key.startsWith('desk'))) throw new Error('Mixed verification report formats')
  }
  if (!terminal) throw new Error('Cucumber report has no terminal record')
  if (!starts.size) throw new Error('Cucumber report has no executed test cases')
  const finalStarts = new Map<string, string>()
  for (const [startId, start] of starts) {
    const test = cases.get(start.testCaseId), end = ends.get(startId)
    if (!test || !end) throw new Error('Cucumber report contains an incomplete test case')
    const completed = steps.get(startId) ?? new Set<string>()
    if (completed.size !== test.testSteps.length || test.testSteps.some(step => !completed.has(step.id))) throw new Error('Cucumber report contains incomplete step results')
    if (!end.willBeRetried) unique(finalStarts, test.pickleId, startId, 'final pickle result')
  }
  for (const startId of ends.keys()) if (!starts.has(startId)) throw new Error('Cucumber report ends an unknown test case')
  for (const startId of steps.keys()) if (!starts.has(startId)) throw new Error('Cucumber report has results for an unknown test case')
  const executedRows = new Set<string>()
  for (const pickle of pickles) {
    const key = scenarioKeys.get(pickle.astNodeIds[0]!)
    if (!key || !finalStarts.has(pickle.id)) throw new Error('Cucumber report has an unexecuted or unknown scenario')
    const rows = scenarioRows.get(pickle.astNodeIds[0]!) ?? []
    const row = rows.length ? pickle.astNodeIds[1] : null
    if (rows.length && (!row || !rows.includes(row)) || pickle.astNodeIds.length !== (rows.length ? 2 : 1)) throw new Error('Cucumber pickle does not match a declared example row')
    const identity = JSON.stringify([key, row])
    if (executedRows.has(identity)) throw new Error('Cucumber report repeats an example row')
    executedRows.add(identity)
    pickleKeys.set(pickle.id, key)
  }
  for (const pickleId of finalStarts.keys()) if (!pickleKeys.has(pickleId)) throw new Error('Cucumber executed an unknown pickle')
  const selected = new Set(finalStarts.values())
  const filtered = envelopes.filter(envelope => {
    if (envelope.testCaseStarted) return selected.has((envelope.testCaseStarted as any).id)
    if (envelope.testStepFinished) return selected.has((envelope.testStepFinished as any).testCaseStartedId)
    return true
  })
  const report = CorpusRunSchema.parse(parseRunMessages(filtered.map(envelope => JSON.stringify(envelope)).join('\n')))
  const expected = new Map(source.contracts.map(contract => [contract.key, contract.rows]))
  if (Object.keys(report.scenarios).length !== expected.size) throw new Error('Cucumber report does not cover the captured corpus')
  for (const [key, rows] of expected) {
    const count = [...pickleKeys.values()].filter(value => value === key).length
    const actual = report.scenarios[key]
    if (!actual || count !== rows || (actual.rows?.length ?? 1) !== rows) throw new Error(`Cucumber report case coverage mismatch: ${key}`)
  }
  if (terminal.success && report.totals.failed) throw new Error('Cucumber terminal success contradicts its test results')
  if (!terminal.success && report.totals.failed === 0 && report.totals.other === 0) throw new Error('Cucumber terminal failure contradicts its passing results')
  return report
}
