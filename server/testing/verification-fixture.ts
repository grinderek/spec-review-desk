import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { attemptDirectory, captureExecutionBoundary, observeAttempt, startLocalAttempt, stopLocalAttempt } from '../execution-receipts.ts'
import { ensureExcluded } from '../git.ts'
import { updateVerification } from '../verification-events.ts'
import { captureVerificationSource } from '../verification-source.ts'

// Prior history uses the production event writer and a real detached command. The fixture
// leaves the terminal receipt unaccepted, as if Desk ended while that command was running.
export async function prepareVerificationAttempt(cwd: string) {
  await ensureExcluded(cwd)
  const source = await captureVerificationSource(cwd)
  const runId = randomUUID(), id = randomUUID(), at = new Date().toISOString()
  const resultFile = path.relative(cwd, path.join(attemptDirectory(cwd, id), 'result.ndjson'))
  const attempt = { id, at, cause: 'initial' as const, processBoundary: await captureExecutionBoundary(), head: source.head, sourceHash: source.hash, routing: null, decisions: [],
    spec: { kind: 'command' as const, bin: process.execPath, cwd, args: ['verify.mjs'], environment: { DESK_RUN_ID: runId, DESK_ATTEMPT_ID: id, DESK_SOURCE_HASH: source.hash, DESK_RESULT_FILE: resultFile }, resultFile } }
  await updateVerification(cwd, () => ({ events: [
    { type: 'VerificationSourceCaptured', runId, source },
    { type: 'ExecutionQueued', request: { id: runId, role: 'verification', threadId: null, messageCount: 0, at } },
    { type: 'ExecutionAttemptRequested', runId, attempt },
  ], value: undefined }))
  return { runId, attempt }
}
export async function prepareVerificationReceipt(cwd: string): Promise<void> {
  const { runId, attempt } = await prepareVerificationAttempt(cwd)
  const id = attempt.id
  await startLocalAttempt(attempt, 5000)
  let observed = await observeAttempt(cwd, id)
  if (observed.kind === 'uncertain') throw new Error(observed.reason)
  const identity = observed.kind === 'live' ? observed.identity : observed.receipt.identity
  await updateVerification(cwd, () => ({ events: [{ type: 'ExecutionAttemptObserved', runId, attemptId: id, identity }], value: undefined }))
  for (let i = 0; i < 250; i++) {
    observed = await observeAttempt(cwd, id)
    if (observed.kind === 'receipt') return
    if (observed.kind === 'uncertain') throw new Error(observed.reason)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await stopLocalAttempt(cwd, id)
  throw new Error('Verification fixture did not publish a receipt')
}
