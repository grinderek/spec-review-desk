import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDeskDsl } from '../server/desk-dsl.ts'
import { executeContractCase, type ContractExecution } from '../server/contract-execution.ts'
import { DeskWorld } from '../server/testing/desk-world.ts'
import { captureVerificationSource } from '../server/verification-source.ts'

const managed = ['DESK_RUN_ID', 'DESK_ATTEMPT_ID', 'DESK_SOURCE_HASH', 'DESK_RESULT_FILE'].map(name => process.env[name])
if (managed.some(Boolean) && !managed.every(Boolean)) throw new Error('Verification execution context is incomplete')
const runId = process.env.DESK_RUN_ID ?? randomUUID()
const attemptId = process.env.DESK_ATTEMPT_ID ?? randomUUID()
const sourceHash = process.env.DESK_SOURCE_HASH ?? (await captureVerificationSource(process.cwd())).hash
const resultFile = process.env.DESK_RESULT_FILE ?? `.spec-review/manual-checks/${attemptId}/result.ndjson`
if (managed.every(Boolean) && resultFile !== `.spec-review/executions/${attemptId}/result.ndjson`) throw new Error('Verification report path does not belong to this attempt')

const root = path.resolve('features')
const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.desk.yaml')).sort()
if (!files.length) throw new Error('No Desk DSL specifications found')
const executions: ContractExecution[] = []
for (const file of files) {
  const doc = parseDeskDsl(await readFile(path.join(root, file), 'utf8'), `features/${file}`)
  for (const scenario of doc.scenarios) {
    for (const [row, parameters] of (scenario.cases ?? [{}]).entries()) {
      const execution = await executeContractCase({ file: `features/${file}`, scenario, row, parameters, createWorld: () => DeskWorld.create() })
      executions.push(execution)
      const label = scenario.cases ? `${scenario.scenario} [${parameters.name ?? row + 1}]` : scenario.scenario
      if (execution.status === 'passed') console.log(`PASS ${label}`)
      else console.error(`FAIL ${label}: ${execution.error?.message ?? 'Execution failed'}`)
    }
  }
}
const passed = executions.filter(result => result.status === 'passed').length, failed = executions.length - passed
const report = { version: 1, runId, attemptId, sourceHash, passed, failed, executions }
await mkdir(path.dirname(resultFile), { recursive: true })
// The complete record is immutable per attempt. The latest JSON is only a derived convenience view.
await writeFile(path.join(path.dirname(resultFile), 'contract-executions.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
await writeFile(resultFile, [...executions.map(result => JSON.stringify({ deskScenarioResult: {
  key: result.key, status: result.status, message: result.error?.message ?? null, row: result.row, rows: result.rows,
} })), JSON.stringify({ deskRunFinished: { at: new Date().toISOString(), runId, attemptId, sourceHash } })].join('\n') + '\n', { flag: 'wx', mode: 0o600 })
await mkdir('.spec-review', { recursive: true })
await writeFile('.spec-review/desk-spec-results.json', JSON.stringify(report, null, 2))
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
