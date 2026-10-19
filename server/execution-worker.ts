import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { appendFile, lstat, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { codexArgs, CodexStream, prepareCodex, type CodexEvent, type ResultEvent } from './codex.ts'
import { ExecutionAttemptSchema, type ExecutionAttempt } from './execution-model.ts'
import { LocalReceiptSchema, processIdentity, writeExecutionArtifact } from './execution-receipts.ts'
import { maskDeep, maskSecrets, SecretHoldback, SecretDetector } from './secret-scan.ts'

// Detached transport worker. Its only durable writes are typed runtime artifacts, not domain
// state. It survives Desk exit and publishes the terminal receipt before ending its process.
const [dir, attemptId] = process.argv.slice(2)
if (!dir || !attemptId) throw new Error('Execution worker requires its directory and attempt id')
const intent = JSON.parse(await readFile(path.join(dir, 'intent.json'), 'utf8'))
const attempt = ExecutionAttemptSchema.parse(intent.attempt)
if (attempt.id !== attemptId) throw new Error('Execution worker attempt identity mismatch')
let stopRequested = false
let interrupt = () => { stopRequested = true }
process.on('SIGINT', () => interrupt())
process.on('SIGTERM', () => interrupt())
const identity = await processIdentity(process.pid, attemptId)
await writeExecutionArtifact(path.join(dir, 'identity.json'), identity)

async function runAgent(spec: Extract<ExecutionAttempt['spec'], { kind: 'agent' }>): Promise<void> {
const prepared = prepareCodex(spec)
try {
const stream = new CodexStream()
let final: ResultEvent | null = null, stopped = false, timedOut = false, secret = false
let actualSession = spec.sessionId
let buffer = '', stderr = '', bytes = 0, logBytes = 0
let writes = Promise.resolve()
const token = process.env.OPENAI_API_KEY ?? null
const narration = new SecretHoldback(token)
const detector = new SecretDetector(token)
const child = spawn(prepared.spec.bin, codexArgs(prepared.spec), { cwd: prepared.spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
const childIdentity = child.pid ? processIdentity(child.pid, attemptId).then(value => writeExecutionArtifact(path.join(dir, 'child.json'), { ...value, pgid: child.pid })).catch(error => {
  if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
}) : Promise.resolve()
let killTimer: NodeJS.Timeout | undefined
const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
const cancel = (owner: boolean) => { stopped ||= owner; signal('SIGINT'); killTimer ??= setTimeout(() => signal('SIGKILL'), 5000); killTimer.unref() }
const terminate = () => cancel(!timedOut)
interrupt = () => { stopRequested = true; terminate() }
if (stopRequested) terminate()
const timer = setTimeout(() => { timedOut = true; terminate() }, Math.max(1, Number(intent.timeoutMs)))
function persist(event: CodexEvent): void {
    const masked = maskDeep(event, token); secret ||= masked.secret
    const encoded = JSON.stringify(masked.value) + '\n'
    logBytes += Buffer.byteLength(encoded)
    if (logBytes > 7_000_000) { stderr = 'Execution output exceeded its size limit'; cancel(false); return }
    writes = writes.then(() => appendFile(path.join(dir!, 'events.jsonl'), encoded, { mode: 0o600 }))
}
function line(text: string): void {
  for (const event of stream.feed(text)) {
    if (event.type === 'init') actualSession = event.sessionId
    if (event.type === 'delta') {
      detector.feed(event.text)
      const released = narration.push(event.text)
      if (released) persist({ type: 'delta', text: released })
    } else if (event.type === 'result') {
      const masked = maskDeep(event, token); secret ||= masked.secret
      final = masked.value
      detector.feed(event.text)
      persist({ type: 'result', ok: event.ok, sessionId: event.sessionId, numTurns: event.numTurns, text: '' })
    } else if (event.type !== 'json_delta') persist(event)
  }
}
child.stdout.on('data', (chunk: Buffer) => {
  bytes += chunk.length
  if (bytes > 16_000_000) { stderr = 'Execution output exceeded its size limit'; cancel(false); return }
  buffer += chunk.toString('utf8')
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
})
child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
let spawnError: string | null = null
const code = await new Promise<number | null>(resolve => {
  child.once('error', error => { spawnError = error.message; resolve(null) })
  child.once('close', code => resolve(code))
  child.stdin.on('error', () => undefined); child.stdin.end(spec.prompt)
})
clearTimeout(timer)
if (killTimer) clearTimeout(killTimer)
if (buffer.trim() && bytes <= 16_000_000) line(buffer)
const tail = narration.flush()
if (tail) persist({ type: 'delta', text: tail })
secret ||= narration.sawSecret || detector.sawSecret
await writes
await childIdentity
const result = final as ResultEvent | null
const ok = code === 0 && result?.ok === true && !stopped && !timedOut && !secret && logBytes <= 7_000_000
const raw = { kind: 'agent' as const, version: 1 as const, attemptId, at: new Date().toISOString(), identity, stopped,
  result: { ok, text: (result?.text ?? '').slice(0, 1_000_000), sessionId: result?.sessionId || actualSession, numTurns: result?.numTurns ?? 0,
    error: ok ? null : secret ? 'A credential appeared in execution output' : stopped ? 'Stopped by the owner' : timedOut ? 'Execution timed out' : spawnError ?? (stderr.trim() || 'The agent ended without a successful result'),
    timedOut, structured: ok ? result?.structured ?? null : null, usage: stream.usage, toolCalls: stream.toolCalls } }
const safe = maskDeep(raw, token)
await writeExecutionArtifact(path.join(dir, 'receipt.json'), LocalReceiptSchema.parse(safe.value))


} finally { prepared.dispose() }
}

async function runCommand(spec: Extract<ExecutionAttempt['spec'], { kind: 'command' }>): Promise<void> {
  const token = process.env.OPENAI_API_KEY ?? null
  const out = new SecretHoldback(token), err = new SecretHoldback(token)
  let stdout = '', stderr = '', bytes = 0, stopped = false, timedOut = false
  let outputError: string | null = null, spawnError: string | null = null
  let killTimer: NodeJS.Timeout | undefined
  const resultFile = path.join(dir!, 'result.ndjson')
  if (spec.resultFile !== null) {
    if (path.resolve(spec.cwd, spec.resultFile) !== resultFile) throw new Error('Command result must use its own attempt artifact path')
    if (await lstat(resultFile).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })) throw new Error('Command result already exists before launch')
  }
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...spec.environment, DESK_ATTEMPT_ID: attemptId } })
  const childIdentity = child.pid ? processIdentity(child.pid, attemptId).then(value => writeExecutionArtifact(path.join(dir, 'child.json'), { ...value, pgid: child.pid })).catch(error => {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }) : Promise.resolve()
  const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  const cancel = (owner: boolean) => { stopped ||= owner; signal('SIGINT'); killTimer ??= setTimeout(() => signal('SIGKILL'), 5000); killTimer.unref() }
  interrupt = () => { stopRequested = true; cancel(true) }
  if (stopRequested) cancel(true)
  const timer = setTimeout(() => { timedOut = true; cancel(false) }, Math.max(1, Number(intent.timeoutMs)))
  function feed(chunk: Buffer, stderrChunk: boolean): void {
    bytes += chunk.length
    if (bytes > 4_000_000) { outputError = 'Command output exceeded its size limit'; cancel(false); return }
    const text = (stderrChunk ? err : out).push(chunk.toString('utf8'))
    if (stderrChunk) stderr = (stderr + text).slice(-1_000_000)
    else stdout = (stdout + text).slice(-1_000_000)
  }
  child.stdout.on('data', (chunk: Buffer) => feed(chunk, false))
  child.stderr.on('data', (chunk: Buffer) => feed(chunk, true))
  const code = await new Promise<number | null>(resolve => {
    child.once('error', error => { spawnError = error.message; resolve(null) })
    child.once('close', code => resolve(code))
  })
  clearTimeout(timer)
  if (killTimer) clearTimeout(killTimer)
  await childIdentity
  stdout = (stdout + out.flush()).slice(-1_000_000)
  stderr = (stderr + err.flush()).slice(-1_000_000)
  const secret = out.sawSecret || err.sawSecret
  let artifact: { hash: string; content: string } | null = null
  let artifactError: string | null = null
  if (spec.resultFile !== null) {
    try {
      if (await realpath(path.dirname(resultFile)) !== dir) throw new Error('Command result directory changed')
      const handle = await open(resultFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > 8_000_000) throw new Error('Command result is not a regular file within its size limit')
        const content = await handle.readFile()
        const after = await handle.stat()
        if (content.length > 8_000_000 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Command result changed while capturing its receipt')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
        if (maskSecrets(text, token).secret) throw new Error('A credential appeared in the command result')
        artifact = { hash: createHash('sha256').update(content).digest('hex'), content: content.toString('base64') }
      } finally { await handle.close() }
    } catch (error) { artifactError = error instanceof Error ? error.message : String(error) }
  }
  const raw = { kind: 'command' as const, version: 1 as const, attemptId, at: new Date().toISOString(), identity, stopped,
    result: { code, stdout, stderr, error: secret ? 'A credential appeared in command output' : outputError ?? spawnError,
      timedOut, artifact, artifactError } }
  // Scan decoded artifact bytes above. Scanning their base64 representation would mistake
  // encoded JSON for a JWT and corrupt the immutable report.
  const safe = maskDeep({ ...raw, result: { ...raw.result, artifact: null } }, token)
  await writeExecutionArtifact(path.join(dir!, 'receipt.json'), LocalReceiptSchema.parse({ ...safe.value, result: { ...safe.value.result, artifact } }))
}

try {
  if (attempt.spec.kind === 'agent') await runAgent(attempt.spec)
  else await runCommand(attempt.spec)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const base = { version: 1 as const, attemptId, at: new Date().toISOString(), identity, stopped: stopRequested }
  const raw = attempt.spec.kind === 'agent'
    ? { ...base, kind: 'agent' as const, result: { ok: false, text: '', sessionId: attempt.spec.sessionId, numTurns: 0, error: message, timedOut: false, structured: null, usage: null, toolCalls: 0 } }
    : { ...base, kind: 'command' as const, result: { code: null, stdout: '', stderr: '', error: message, timedOut: false, artifact: null, artifactError: 'Command preparation or receipt capture failed' } }
  await writeExecutionArtifact(path.join(dir, 'receipt.json'), LocalReceiptSchema.parse(maskDeep(raw, process.env.OPENAI_API_KEY ?? null).value))
}
