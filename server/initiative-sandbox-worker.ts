import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventBus } from './events.ts'
import { writeExecutionArtifact } from './execution-receipts.ts'
import { InitiativeAttemptInputSchema, InitiativeAttemptResultSchema } from './initiative-attempt.ts'
import { streamAttempt } from './run-stream.ts'
import type { Sandbox } from './sandbox.ts'
import { maskDeep, ROTATE_HINT, SecretDetector } from './secret-scan.ts'

const [inputFile, resultFile, expectedHash] = process.argv.slice(2)
if (!inputFile || !resultFile || !expectedHash) throw new Error('Initiative worker requires immutable input, result path and source hash')
const input = InitiativeAttemptInputSchema.parse(JSON.parse(await readFile(inputFile, 'utf8')))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
if (sha(JSON.stringify(input)) !== expectedHash) throw new Error('Initiative input changed before execution')
async function roomFiles(dir:string,prefix=''):Promise<string[]> {
  const files:string[]=[]
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative=prefix?`${prefix}/${entry.name}`:entry.name
    if(entry.isDirectory())files.push(...await roomFiles(path.join(dir,entry.name),relative))
    else if(entry.isFile())files.push(`${relative}:${sha(await readFile(path.join(dir,entry.name)))}`)
    else throw new Error('Execution room contains a non-regular file')
  }
  return files
}
if(sha(JSON.stringify(await roomFiles(input.room)))!==input.source.roomHash)throw new Error('Execution room changed before execution')
const provider = await import(input.provider.module) as { createDurableSandbox(config: unknown): Sandbox }
const sandbox = provider.createDurableSandbox(input.provider.config)
let stopping = false
const stop = () => { stopping = true; void sandbox.stop(input.sandboxId) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
const token = await sandbox.token()
await mkdir(path.join(input.runDir, 'sandbox'), { recursive: true })
const cancelled = await readFile(path.join(input.runDir,'stop.request')).then(()=>true,()=>false)
const captured = cancelled ? {outcome:{code:null,stopped:true,timedOut:false,error:null},resultEvent:null,sawSecret:false,usage:null,toolCalls:0} : await streamAttempt({ sandbox, token, detector: new SecretDetector(token), bus: new EventBus(), channel: '',
  logFile: input.log, resume: input.codex.resume, timeoutMs: input.timeoutMs,
  spec: { runId: input.sandboxId, runDir: path.join(input.runDir, 'sandbox'), room: input.room, out: input.out, sessions: input.sessions,
    domains: input.domains, browser: input.browser, retain: true, stopFile:path.join(input.runDir,'stop.request'), codex: input.codex },
})
const outputs: { path: string; content: string; mode: number }[] = []
let bytes = 0
async function capture(dir: string, prefix = ''): Promise<void> {
  for (const name of (await readdir(dir)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name
    const file = path.join(dir, name), info = await lstat(file)
    if (info.isSymbolicLink()) throw new Error('Agent output contains a symlink')
    if (info.isDirectory()) await capture(file, relative)
    else if (info.isFile()) {
      if (info.size > 4_000_000 || bytes + info.size > 5_000_000 || outputs.length >= 200) throw new Error('Agent output exceeds its recoverable size limit')
      const text = await readFile(file, 'utf8'); bytes += Buffer.byteLength(text)
      outputs.push({ path: relative, content: text, mode: info.mode & 0o111 ? 0o755 : 0o644 })
    } else throw new Error('Agent output contains a non-regular file')
  }
}
let captureError: string | null = null
try { await capture(input.out) } catch (error) { captureError = error instanceof Error ? error.message : String(error) }
const candidate = { version: 1 as const, attemptId: input.attemptId,
  outcome: { ...captured.outcome, stopped: captured.outcome.stopped || stopping, error: captureError ?? captured.outcome.error },
  result: captured.resultEvent ? { ok: captured.resultEvent.ok, text: captured.resultEvent.text, sessionId: captured.resultEvent.sessionId, structured: captured.resultEvent.structured } : null,
  outputs, usage: captured.usage, toolCalls: captured.toolCalls, sawSecret: captured.sawSecret }
const safe = maskDeep(candidate, token)
const joined = maskDeep(outputs.map(output => output.content).join(''), token)
if (captured.sawSecret || safe.secret || joined.secret) {
  safe.value.result = null; safe.value.outputs = []; safe.value.sawSecret = true
  safe.value.outcome.error = ROTATE_HINT
}
await writeExecutionArtifact(resultFile, InitiativeAttemptResultSchema.parse(safe.value))
// The exited container remains inspectable until the domain accepts the receipt and finalizes it.
