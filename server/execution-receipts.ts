import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CodexEvent } from './codex.ts'
import { ExecutionAttemptSchema, type ExecutionAttempt, ProcessBoundarySchema, type ProcessBoundary, ProcessIdentitySchema, type ProcessIdentity } from './execution-model.ts'

const ReceiptBase = z.object({
  version: z.literal(1), attemptId: z.uuid(), at: z.string(), identity: ProcessIdentitySchema,
  stopped: z.boolean(),
})
export const AgentReceiptSchema = ReceiptBase.extend({ kind: z.literal('agent'),
  result: z.object({ ok: z.boolean(), text: z.string().max(2_000_000), sessionId: z.string(), numTurns: z.number(), error: z.string().nullable(), timedOut: z.boolean(), structured: z.unknown(), usage: z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).nullable(), toolCalls: z.number() }),
})
const CommandArtifactSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), content: z.string().max(11_000_000) }).superRefine((artifact, ctx) => {
  const bytes = Buffer.from(artifact.content, 'base64')
  if (bytes.length > 8_000_000 || bytes.toString('base64') !== artifact.content || createHash('sha256').update(bytes).digest('hex') !== artifact.hash) {
    ctx.addIssue({ code: 'custom', message: 'Command artifact content does not match its hash or size limit' })
  }
})
export const CommandReceiptSchema = ReceiptBase.extend({ kind: z.literal('command'), result: z.object({
  code: z.number().int().nullable(), stdout: z.string().max(1_000_000), stderr: z.string().max(1_000_000),
  error: z.string().nullable(), timedOut: z.boolean(), artifactError: z.string().nullable(),
  artifact: CommandArtifactSchema.nullable(),
}) })
export const LocalReceiptSchema = z.discriminatedUnion('kind', [AgentReceiptSchema, CommandReceiptSchema])
export type LocalReceipt = z.infer<typeof LocalReceiptSchema>
export type AgentReceipt = z.infer<typeof AgentReceiptSchema>
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>
const worker = fileURLToPath(new URL('./execution-worker.ts', import.meta.url))
const LaunchSchema = ProcessBoundarySchema
let clockTicks: Promise<number> | undefined
export async function captureExecutionBoundary(): Promise<ProcessBoundary> {
  clockTicks ??= promisify(execFile)('getconf', ['CLK_TCK']).then(({ stdout }) => {
    const ticks = Number(stdout.trim())
    if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error('Cannot read the kernel process clock frequency')
    return ticks
  })
  const ticks = await clockTicks
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0])
  if (!Number.isFinite(uptime) || uptime < 0) throw new Error('Cannot read the kernel process clock')
  return LaunchSchema.parse({ bootId, startTicks: String(Math.floor(uptime * ticks)) })
}
export const attemptDirectory = (cwd: string, attemptId: string): string => path.join(cwd, '.spec-review', 'executions', z.uuid().parse(attemptId))
async function readArtifact(cwd: string, attemptId: string, name: string, limit: number): Promise<string> {
  const dir = attemptDirectory(cwd, attemptId)
  const root = await realpath(cwd)
  if (await realpath(dir) !== path.join(root, '.spec-review', 'executions', attemptId)) throw new Error('Execution artifact directory changed')
  const handle = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error('Execution artifact is not a regular file within its size limit')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Execution artifact changed while being read')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { await handle.close() }
}
export async function writeExecutionArtifact(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    // An attempt's intent, identity and terminal receipt are immutable once published.
    await link(tmp, file)
  } finally { await unlink(tmp) }
}
export async function processIdentity(pid: number, attemptId: string): Promise<ProcessIdentity> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  return ProcessIdentitySchema.parse({ pid, attemptId, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
}
export async function identityLive(identity: ProcessIdentity): Promise<boolean> {
  try {
    const actual = await processIdentity(identity.pid, identity.attemptId)
    const command = (await readFile(`/proc/${identity.pid}/cmdline`, 'utf8')).split('\0')
    return actual.bootId === identity.bootId && actual.startTicks === identity.startTicks && command.includes(worker) && command.includes(identity.attemptId)
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}
export type AttemptObservation = { kind: 'receipt'; receipt: LocalReceipt; hash: string }
  | { kind: 'live'; identity: ProcessIdentity } | { kind: 'uncertain'; reason: string }
export async function observeAttempt(cwd: string, attemptId: string): Promise<AttemptObservation> {
  const dir = attemptDirectory(cwd, attemptId)
  try {
    const text = await readArtifact(cwd, attemptId, 'receipt.json', 14_000_000)
    const receipt = LocalReceiptSchema.parse(JSON.parse(text))
    if (receipt.attemptId !== attemptId || receipt.identity.attemptId !== attemptId) throw new Error('Execution receipt identity mismatch')
    const identity = ProcessIdentitySchema.parse(JSON.parse(await readArtifact(cwd, attemptId, 'identity.json', 10_000)))
    const intent = JSON.parse(await readArtifact(cwd, attemptId, 'intent.json', 8_000_000))
    const attempt = ExecutionAttemptSchema.parse(intent.attempt)
    if (attempt.id !== attemptId || receipt.kind !== attempt.spec.kind || JSON.stringify(identity) !== JSON.stringify(receipt.identity)) throw new Error('Execution receipt does not match its recorded intent and worker identity')
    return { kind: 'receipt', receipt, hash: createHash('sha256').update(text).digest('hex') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'uncertain', reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    const identity = ProcessIdentitySchema.parse(JSON.parse(await readArtifact(cwd, attemptId, 'identity.json', 10_000)))
    if (identity.attemptId !== attemptId) throw new Error('Execution process identity mismatch')
    if (await identityLive(identity)) return { kind: 'live', identity }
    // The worker writes its receipt before exiting; re-read to close that observation race.
    try { await readArtifact(cwd, attemptId, 'receipt.json', 14_000_000); return observeAttempt(cwd, attemptId) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'uncertain', reason: error instanceof Error ? error.message : String(error) }
    }
    return { kind: 'uncertain', reason: 'The recorded execution process ended without a terminal receipt' }
  } catch (error) { return { kind: 'uncertain', reason: `Cannot prove execution outcome: ${error instanceof Error ? error.message : String(error)}` } }
}
export async function startLocalAttempt(attempt: ExecutionAttempt, timeoutMs: number, environment?: NodeJS.ProcessEnv): Promise<void> {
  const dir = attemptDirectory(attempt.spec.cwd, attempt.id)
  const root = await realpath(attempt.spec.cwd)
  for (const relative of ['.spec-review', '.spec-review/executions']) {
    const target = path.join(root, relative)
    await mkdir(target, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) throw new Error('Execution artifact directory is unsafe')
  }
  // Reusing an attempt ID never starts a second external process.
  await mkdir(dir, { mode: 0o700 })
  await writeExecutionArtifact(path.join(dir, 'intent.json'), { attempt, timeoutMs, launch: await captureExecutionBoundary() })
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), worker, dir, attempt.id], {
    cwd: attempt.spec.cwd, detached: true, stdio: 'ignore', env: { ...process.env, ...environment, DESK_ATTEMPT_ID: attempt.id },
  })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  // Only the worker may prove it started. A parent PID is not sufficient evidence.
  for (let i = 0; i < 100; i++) {
    const observation = await observeAttempt(attempt.spec.cwd, attempt.id)
    if (observation.kind !== 'uncertain') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Execution worker did not publish a verifiable identity')
}
async function attemptProcesses(cwd: string, attemptId: string, hint?: ProcessBoundary): Promise<ProcessIdentity[]> {
  z.uuid().parse(attemptId)
  const directory = attemptDirectory(cwd, attemptId)
  // Losing runtime files does not prove that a detached process ended. The domain journal's
  // kernel birth bound survives cache loss; without one, scan exact markers and fail closed
  // if inaccessible processes prevent proving inactivity.
  let wrapper: ProcessIdentity | null = null
  let boundary: ProcessBoundary | null = hint ? ProcessBoundarySchema.parse(hint) : null
  try {
    wrapper = ProcessIdentitySchema.parse(JSON.parse(await readArtifact(cwd, attemptId, 'identity.json', 10_000)))
    if (wrapper.attemptId !== attemptId) throw new Error('Execution wrapper identity mismatch')
    boundary = wrapper
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      const intent = JSON.parse(await readArtifact(cwd, attemptId, 'intent.json', 8_000_000))
      if (intent.attempt?.id !== attemptId) throw new Error('Execution intent identity mismatch')
      boundary = LaunchSchema.parse(intent.launch)
    } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
  }
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (boundary && boundary.bootId !== bootId) return []
  let childGroup: number | null = null
  try {
    const child = ProcessIdentitySchema.extend({ pgid: z.number().int().positive() }).parse(JSON.parse(await readArtifact(cwd, attemptId, 'child.json', 10_000)))
    if (child.attemptId !== attemptId) throw new Error('Execution child identity mismatch')
    // A numeric process group can be reused. Trust it only while its original leader lives.
    if (child.bootId === bootId && child.pgid === child.pid) {
      try {
        const actual = await processIdentity(child.pid, attemptId)
        if (actual.bootId === child.bootId && actual.startTicks === child.startTicks) childGroup = child.pgid
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const active: ProcessIdentity[] = []
  let inaccessible: number | null = null
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(')').slice(1).join(')').trimStart().split(' ')
      if (fields[0] === 'Z' || fields[0] === 'X' || boundary && BigInt(fields[19]!) < BigInt(boundary.startTicks)) continue
      if ((await stat(`/proc/${pid}`)).uid !== process.getuid?.()) continue
      let matches = !!wrapper && pid === wrapper.pid && fields[19] === wrapper.startTicks && await identityLive(wrapper)
      matches ||= childGroup !== null && Number(fields[2]) === childGroup
      if (!matches) {
        matches = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').includes(`DESK_ATTEMPT_ID=${attemptId}`)
      }
      if (matches) active.push(ProcessIdentitySchema.parse({ pid, bootId, startTicks: fields[19], attemptId }))
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      inaccessible ??= pid
    }
  }
  if (!active.length && inaccessible !== null) throw new Error(`Cannot establish whether process ${inaccessible} belongs to the execution`)
  return active
}
export async function attemptProcessesLive(cwd: string, attemptId: string, boundary?: ProcessBoundary): Promise<boolean> {
  return (await attemptProcesses(cwd, attemptId, boundary)).length > 0
}
export async function requireAttemptInactive(cwd: string, attemptId: string, boundary?: ProcessBoundary): Promise<void> {
  if (await attemptProcessesLive(cwd, attemptId, boundary)) throw new Error('The previous attempt still has a live execution process')
}
export async function stopLocalAttempt(cwd: string, attemptId: string, boundary?: ProcessBoundary): Promise<boolean> {
  const processes = await attemptProcesses(cwd, attemptId, boundary)
  let signalled = false
  for (const identity of processes) {
    try {
      const actual = await processIdentity(identity.pid, attemptId)
      if (actual.bootId !== identity.bootId || actual.startTicks !== identity.startTicks) continue
      process.kill(identity.pid, 'SIGINT'); signalled = true
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  return signalled
}
export async function executionLog(cwd: string, attemptId: string): Promise<CodexEvent[]> {
  const text = await readFile(path.join(attemptDirectory(cwd, attemptId), 'events.jsonl'), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error
  })
  if (Buffer.byteLength(text) > 8_000_000) throw new Error('Execution log exceeds its size limit')
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as CodexEvent] } catch { return [] } })
}
