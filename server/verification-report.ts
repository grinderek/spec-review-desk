import { z } from 'zod'
import { CorpusRunSchema } from './verification-events.ts'
import type { VerificationSource } from './verification-source.ts'
import { acceptCucumberVerification } from './verification-cucumber.ts'

const Status = z.enum(['passed', 'failed', 'undefined', 'pending', 'skipped', 'ambiguous', 'unknown'])
const ResultSchema = z.object({ key: z.string().min(1), status: Status, message: z.string().nullable(), row: z.number().int().nonnegative().nullable(), rows: z.number().int().positive().nullable() }).strict()
const FinishedSchema = z.object({ at: z.iso.datetime(), runId: z.uuid(), attemptId: z.uuid(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const severity = ['passed', 'unknown', 'skipped', 'pending', 'undefined', 'ambiguous', 'failed']

// A report is evidence for exactly one persisted attempt and its captured input manifest.
// Truncated, repeated, mixed or foreign results are rejected as a whole, never painted green.
export function acceptVerificationReport(bytes: Buffer, expected: { runId: string; attemptId: string; source: VerificationSource }): z.infer<typeof CorpusRunSchema> {
  if (bytes.length > 8_000_000) throw new Error('Verification report exceeds its size limit')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const lines = text.split('\n').filter(line => line.trim())
  if (!lines.length) throw new Error('Verification report is empty')
  const envelopes = lines.map(line => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
  if (!envelopes.some(envelope => 'deskScenarioResult' in envelope || 'deskRunFinished' in envelope)) return acceptCucumberVerification(envelopes, expected.source)
  const source = new Map(expected.source.contracts.map(contract => [contract.key, contract]))
  const seen = new Set<string>()
  const scenarios: z.infer<typeof CorpusRunSchema>['scenarios'] = {}
  const totals = { passed: 0, failed: 0, other: 0 }
  let finishedAt: string | null = null
  for (const [index, line] of lines.entries()) {
    const envelope = envelopes[index]!
    if (Object.keys(envelope).length !== 1) throw new Error('Verification report envelope must contain one result')
    if ('deskRunFinished' in envelope) {
      if (index !== lines.length - 1 || finishedAt) throw new Error('Verification report terminal record is not unique and last')
      const terminal = FinishedSchema.parse(envelope.deskRunFinished)
      if (terminal.runId !== expected.runId || terminal.attemptId !== expected.attemptId || terminal.sourceHash !== expected.source.hash) throw new Error('Verification report belongs to different execution inputs')
      finishedAt = terminal.at
      continue
    }
    if (!('deskScenarioResult' in envelope)) throw new Error('Unknown verification report record')
    const result = ResultSchema.parse(envelope.deskScenarioResult)
    const contract = source.get(result.key)
    if (!contract) throw new Error(`Verification report includes an unknown contract: ${result.key}`)
    const row = result.row ?? 0
    if ((result.rows ?? 1) !== contract.rows || row >= contract.rows || result.row === null && contract.rows !== 1) throw new Error(`Verification report case count differs from its inputs: ${result.key}`)
    const identity = JSON.stringify([result.key, row])
    if (seen.has(identity)) throw new Error(`Duplicate verification result: ${result.key} case ${row}`)
    seen.add(identity)
    if (result.status === 'passed') totals.passed++
    else if (result.status === 'failed') totals.failed++
    else totals.other++
    const previous = scenarios[result.key]
    const rows = result.rows !== null ? [...(previous?.rows ?? Array<z.infer<typeof Status>>(contract.rows).fill('unknown'))] : null
    if (rows) rows[row] = result.status
    const status = previous && severity.indexOf(previous.status) > severity.indexOf(result.status) ? previous.status : result.status
    scenarios[result.key] = { status, rows, failure: previous?.failure ?? (result.message ? { step: 'contract', message: result.message } : null) }
  }
  if (!finishedAt) throw new Error('Verification report has no terminal record')
  if (seen.size !== expected.source.contracts.reduce((count, contract) => count + contract.rows, 0)) throw new Error('Verification report does not cover every captured contract case')
  return CorpusRunSchema.parse({ scenarios, totals, finishedAt })
}
