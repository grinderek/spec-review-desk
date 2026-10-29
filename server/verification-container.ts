import { z } from 'zod'
import { run } from './git.ts'

export const verificationContainerName = (attemptId: string): string => `srd-verification-${z.uuid().parse(attemptId)}`
export type VerificationContainer = { name: string; id: string | null }
export type ContainerObservation = { kind: 'missing' } | { kind: 'live' | 'terminal'; id: string; exitCode: number; status: string }
const Inspect = z.object({ Id: z.string().regex(/^[0-9a-f]{64}$/), Name: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }), RestartCount: z.number().int().nonnegative(), HostConfig: z.object({ RestartPolicy: z.object({ Name: z.string(), MaximumRetryCount: z.number().int().nonnegative() }) }), State: z.object({ Running: z.boolean(), Paused: z.boolean(), Restarting: z.boolean(), Status: z.string(), ExitCode: z.number().int() }) })

export async function inspectVerificationContainer(cwd: string, runId: string, attemptId: string, container: VerificationContainer): Promise<ContainerObservation> {
  if (container.name !== verificationContainerName(attemptId)) throw new Error('Verification container name does not belong to its attempt')
  const result = await run('docker', ['container', 'inspect', container.id ?? container.name], { cwd, timeoutMs: 30_000, allowFailure: true })
  if (result.code !== 0) {
    if (/No such (?:object|container):/i.test(result.stderr)) return { kind: 'missing' }
    throw new Error('Cannot inspect the verification container')
  }
  const items = z.array(Inspect).length(1).parse(JSON.parse(result.stdout))
  const item = items[0]!
  if (container.id && item.Id !== container.id || item.Name !== `/${container.name}` || item.Config.Labels?.['dev.desk.attempt'] !== attemptId || item.Config.Labels?.['dev.desk.run'] !== runId) throw new Error('Verification container identity mismatch')
  const oneShot = item.HostConfig.RestartPolicy.Name === 'no' && item.RestartCount === 0
  const terminal = oneShot && !item.State.Running && !item.State.Paused && !item.State.Restarting && ['exited', 'dead'].includes(item.State.Status)
  return { kind: terminal ? 'terminal' : 'live', id: item.Id, exitCode: item.State.ExitCode, status: oneShot ? item.State.Status : `${item.State.Status}; restart policy ${item.HostConfig.RestartPolicy.Name}, restart count ${item.RestartCount}` }
}
export async function stopVerificationContainer(cwd: string, runId: string, attemptId: string, container: VerificationContainer): Promise<void> {
  const observed = await inspectVerificationContainer(cwd, runId, attemptId, container)
  if (observed.kind === 'missing' || observed.kind === 'terminal') return
  // Address the verified immutable ID, never a name that another container could acquire.
  const result = await run('docker', ['container', 'stop', '--time', '5', observed.id], { cwd, timeoutMs: 30_000, allowFailure: true })
  if (result.code !== 0) throw new Error('Cannot stop the verification container')
}

// Cleanup never addresses a mutable name and never forces removal of a running container.
// Its caller must have persisted a cleanup intent bound to an accepted terminal result.
export async function removeTerminalVerificationContainer(cwd: string, runId: string, attemptId: string, container: VerificationContainer): Promise<void> {
  if (!container.id) throw new Error('Container cleanup requires its recorded immutable ID')
  const before = await inspectVerificationContainer(cwd, runId, attemptId, container)
  if (before.kind === 'missing') return
  if (before.kind !== 'terminal') throw new Error(`Verification container is not safely terminal: ${before.status}`)
  const removed = await run('docker', ['container', 'rm', before.id], { cwd, timeoutMs: 30_000, allowFailure: true })
  // A concurrent idempotent cleanup may already have removed this same immutable ID.
  const after = await inspectVerificationContainer(cwd, runId, attemptId, container)
  if (after.kind === 'missing') return
  if (removed.code !== 0) throw new Error('Cannot remove the terminal verification container')
  throw new Error('Verification container still exists after cleanup')
}
