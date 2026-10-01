import path from 'node:path'

export type RunStatus = 'passed' | 'failed' | 'undefined' | 'pending' | 'skipped' | 'ambiguous' | 'unknown'
export interface ScenarioRun { status: RunStatus; failure: { step: string; message: string } | null; rows: RunStatus[] | null }
export interface CorpusRun {
  scenarios: Record<string, ScenarioRun>
  totals: { passed: number; failed: number; other: number }
  finishedAt: string | null
}

const SEVERITY: RunStatus[] = ['passed', 'unknown', 'skipped', 'pending', 'undefined', 'ambiguous', 'failed']
const worst = (a: RunStatus, b: RunStatus): RunStatus => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b)
const toStatus = (raw: unknown): RunStatus => {
  const s = String(raw ?? 'UNKNOWN').toLowerCase()
  return (SEVERITY as string[]).includes(s) ? (s as RunStatus) : 'unknown'
}

export const corpusKey = (file: string, title: string): string => `${path.posix.basename(file)}::${title}`

interface Pickle { id: string; uri: string; astNodeIds: string[]; steps: { id: string; text: string }[] }
interface ScenarioNode { name: string; uri: string; rows: string[] }

export function parseRunMessages(ndjson: string): CorpusRun {
  const scenarioNodes = new Map<string, ScenarioNode>()
  const pickles = new Map<string, Pickle>()
  const testCases = new Map<string, { pickleId: string; steps: Map<string, string | null> }>()
  const started = new Map<string, string>()
  const results = new Map<string, { status: RunStatus; failure: ScenarioRun['failure'] }>()
  let finishedAt: string | null = null
  const deskTotals = { passed: 0, failed: 0, other: 0 }
  const deskScenarios: Record<string, ScenarioRun> = {}

  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    let envelope: Record<string, any>
    try {
      envelope = JSON.parse(line)
    } catch {
      continue
    }
    if (envelope.deskScenarioResult) {
      const r = envelope.deskScenarioResult
      const status = toStatus(r.status)
      if (status === 'passed') deskTotals.passed++
      else if (status === 'failed') deskTotals.failed++
      else deskTotals.other++
      const previous = deskScenarios[String(r.key)]
      const rows = Number.isInteger(r.rows) && r.rows > 0 ? [...(previous?.rows ?? Array<RunStatus>(r.rows).fill('unknown'))] : null
      if (rows && Number.isInteger(r.row) && r.row >= 0 && r.row < rows.length) rows[r.row] = status
      deskScenarios[String(r.key)] = { status: previous ? worst(previous.status, status) : status, failure: previous?.failure ?? (r.message ? { step: 'contract', message: String(r.message) } : null), rows }
    } else if (envelope.deskRunFinished) { finishedAt = String(envelope.deskRunFinished.at)
    } else if (envelope.gherkinDocument) {
      const doc = envelope.gherkinDocument
      const children: any[] = doc.feature?.children ?? []
      const scenarios = children.flatMap((c) => (c.rule ? c.rule.children : [c])).flatMap((c: any) => (c.scenario ? [c.scenario] : []))
      for (const s of scenarios) {
        scenarioNodes.set(s.id, { name: s.name, uri: doc.uri, rows: (s.examples ?? []).flatMap((e: any) => (e.tableBody ?? []).map((r: any) => r.id)) })
      }
    } else if (envelope.pickle) {
      pickles.set(envelope.pickle.id, envelope.pickle)
    } else if (envelope.testCase) {
      const tc = envelope.testCase
      testCases.set(tc.id, { pickleId: tc.pickleId, steps: new Map((tc.testSteps ?? []).map((s: any) => [s.id, s.pickleStepId ?? null])) })
    } else if (envelope.testCaseStarted) {
      started.set(envelope.testCaseStarted.id, envelope.testCaseStarted.testCaseId)
    } else if (envelope.testStepFinished) {
      const f = envelope.testStepFinished
      const testCaseId = started.get(f.testCaseStartedId)
      const testCase = testCaseId ? testCases.get(testCaseId) : undefined
      if (!testCase) continue
      const status = toStatus(f.testStepResult?.status)
      const current = results.get(testCase.pickleId) ?? { status: 'passed' as RunStatus, failure: null }
      const pickleStepId = testCase.steps.get(f.testStepId)
      const stepText = pickles.get(testCase.pickleId)?.steps.find((s) => s.id === pickleStepId)?.text ?? 'hook'
      const failure = status === 'failed' && !current.failure ? { step: stepText, message: String(f.testStepResult?.message ?? '') } : current.failure
      results.set(testCase.pickleId, { status: worst(current.status, status), failure })
    } else if (envelope.testRunFinished?.timestamp) {
      const t = envelope.testRunFinished.timestamp
      finishedAt = new Date(Number(t.seconds) * 1000 + Math.floor(Number(t.nanos ?? 0) / 1e6)).toISOString()
    }
  }

  const scenarios: Record<string, ScenarioRun> = {}
  const totals = { passed: 0, failed: 0, other: 0 }
  for (const pickle of pickles.values()) {
    const node = scenarioNodes.get(pickle.astNodeIds[0] ?? '')
    const result = results.get(pickle.id) ?? { status: 'unknown' as RunStatus, failure: null }
    if (result.status === 'passed') totals.passed++
    else if (result.status === 'failed') totals.failed++
    else totals.other++
    if (!node) continue
    const key = corpusKey(node.uri, node.name)
    const previous = scenarios[key]
    const rowIndex = pickle.astNodeIds[1] ? node.rows.indexOf(pickle.astNodeIds[1]) : -1
    const rows = node.rows.length ? [...(previous?.rows ?? node.rows.map((): RunStatus => 'unknown'))] : null
    if (rows && rowIndex >= 0) rows[rowIndex] = result.status
    scenarios[key] = {
      status: previous ? worst(previous.status, result.status) : result.status,
      failure: previous?.failure ?? result.failure,
      rows,
    }
  }
  for (const [key, scenario] of Object.entries(deskScenarios)) {
    scenarios[key] = scenario
  }
  totals.passed += deskTotals.passed; totals.failed += deskTotals.failed; totals.other += deskTotals.other
  return { scenarios, totals, finishedAt }
}
