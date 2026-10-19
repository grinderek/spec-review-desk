import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { GitEffectPlanSchema } from './git-effect.ts'
import { InputSchema, INITIATIVE_NAME } from './initiative-model.ts'
import { withReviewLock } from './review-lock.ts'
import { WORKTREE_EVENTS_FILE, initiativeRelative, worktreeRel } from './creation-layout.ts'
import { ProcessBoundarySchema } from './execution-model.ts'

const Sha = z.string().regex(/^[0-9a-f]{40,64}$/), Hash = z.string().regex(/^[0-9a-f]{64}$/)
export const WorktreeIdentitySchema = z.object({ root: z.string(), gitDir: z.string(), commonDir: z.string(), branch: z.string().nullable() })
export const CreationRequestSchema = z.object({
  id: z.uuid(), requestHash: Hash, name: z.string().regex(INITIATIVE_NAME), title: z.string(), repo: z.string(), at: z.string(),
  processBoundary: ProcessBoundarySchema,
  anchor: WorktreeIdentitySchema, targetPath: z.string(), base: Sha, branch: z.string().nullable(),
  where: z.discriminatedUnion('kind', [z.object({ kind: z.literal('new'), base: z.string() }), z.object({ kind: z.literal('existing'), worktreeId: z.string() })]),
  existingIdentity: WorktreeIdentitySchema.nullable(), streamId: z.uuid(), commandId: z.uuid(),
  brief: Hash, inputs: z.array(InputSchema), trailer: z.string(),
})
export type CreationRequest = z.infer<typeof CreationRequestSchema>
export function creationRequestHash(value: unknown): string {
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}
export type WorktreeIdentity = z.infer<typeof WorktreeIdentitySchema>
export const WorktreeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('InitiativeCreationRequested'), request: CreationRequestSchema }),
  z.object({ type: z.literal('InitiativeWorktreeConfirmed'), creationId: z.uuid(), identity: WorktreeIdentitySchema }),
  z.object({ type: z.literal('InitiativeCreationGitRequested'), creationId: z.uuid(), plan: GitEffectPlanSchema }),
  z.object({ type: z.literal('InitiativeCreationObserved'), creationId: z.uuid(), status: z.enum(['pending', 'uncertain', 'failed', 'not_started']), reason: z.string() }),
  z.object({ type: z.literal('InitiativeCreationCompleted'), creationId: z.uuid(), commit: Sha }),
])
export type WorktreeEvent = z.infer<typeof WorktreeEventSchema>
const Envelope = z.object({ version: z.literal(1), stream: z.uuid(), sequence: z.number().int().positive(), id: z.uuid(), command: z.uuid(), at: z.string(), event: WorktreeEventSchema })
type Envelope = z.infer<typeof Envelope>
export interface CreationState { request: CreationRequest; identity: WorktreeIdentity | null; plan: z.infer<typeof GitEffectPlanSchema> | null; status: 'requested' | 'pending' | 'uncertain' | 'failed' | 'not_started' | 'completed'; reason: string | null; commit: string | null }
export function projectWorktree(events: readonly Envelope[]): CreationState[] {
  const creations: CreationState[] = []
  for (const { event } of events) {
    if (event.type === 'InitiativeCreationRequested') {
      if (creations.some(state => state.request.id === event.request.id || state.request.name === event.request.name)) throw new Error('Duplicate initiative creation request')
      const request = event.request
      if (request.requestHash !== creationRequestHash({ name: request.name, repo: request.repo, title: request.title, where: request.where, brief: request.brief,
        inputs: request.inputs.map(({ added_at, ...entry }) => entry) })) throw new Error('Creation input identity mismatch')
      if (request.where.kind === 'new' && (request.targetPath !== path.join(request.anchor.root, worktreeRel(request.name)) || request.branch !== `refs/heads/plan/${request.name}` || request.existingIdentity !== null)) throw new Error('Creation worktree location mismatch')
      creations.push({ request: event.request, identity: null, plan: null, status: 'requested', reason: null, commit: null }); continue
    }
    const state = creations.find(state => state.request.id === event.creationId)
    if (!state || state.status === 'completed') throw new Error('Creation event has no open request')
    if (event.type === 'InitiativeWorktreeConfirmed') {
      if (state.identity || event.identity.root !== state.request.targetPath || event.identity.commonDir !== state.request.anchor.commonDir || event.identity.branch !== state.request.branch) throw new Error('Creation worktree identity mismatch')
      state.identity = event.identity
    } else if (event.type === 'InitiativeCreationGitRequested') {
      if (!state.identity || state.plan || event.plan.expectedHead !== state.request.base || event.plan.purpose.kind !== 'initiative-creation' || event.plan.purpose.ref !== state.request.id) throw new Error('Creation Git intent mismatch')
      const relative = initiativeRelative(state.request.name)
      if (event.plan.extraFiles.length || !event.plan.files.some(file => file.path === `${relative}/initiative.events.jsonl`) || event.plan.files.some(file => !file.path.startsWith(relative + '/'))) throw new Error('Creation Git outputs escape the initial initiative')
      state.plan = event.plan; state.status = 'pending'
    } else if (event.type === 'InitiativeCreationCompleted') {
      if (!state.plan) throw new Error('Creation completed without a Git intent')
      state.status = 'completed'; state.commit = event.commit; state.reason = null
    } else { state.status = event.status; state.reason = event.reason }
  }
  return creations
}
export async function readWorktreeStream(anchor: string): Promise<{ events: Envelope[]; creations: CreationState[]; bytes: string }> {
  let bytes: string
  try {
    const root = await realpath(anchor), directory = path.join(root, '.spec-review')
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe worktree stream parent')
    const handle = await open(path.join(root, WORKTREE_EVENTS_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat(); if (!before.isFile() || before.size > 20_000_000) throw new Error('Invalid worktree stream file')
      const content = Buffer.alloc(before.size)
      let position = 0
      while (position < content.length) { const read = await handle.read(content, position, content.length - position, position); if (!read.bytesRead) throw new Error('Worktree stream changed'); position += read.bytesRead }
      const after = await handle.stat()
      if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error('Worktree stream changed while reading')
      bytes = new TextDecoder('utf-8', { fatal: true }).decode(content)
    } finally { await handle.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = '' }
  const events = bytes.split('\n').filter(Boolean).map(line => Envelope.parse(JSON.parse(line)))
  const ids = new Set<string>()
  events.forEach((event, index) => { if (event.sequence !== index + 1 || event.stream !== events[0]!.stream || ids.has(event.id)) throw new Error('Invalid worktree history'); ids.add(event.id) })
  return { events, bytes, creations: projectWorktree(events) }
}
export async function recordWorktreeEvents(anchor: string, decide: (states: CreationState[]) => Promise<WorktreeEvent[]> | WorktreeEvent[]): Promise<void> {
  const root = await realpath(anchor), directory = path.join(root, '.spec-review')
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe worktree runtime directory')
  await withReviewLock(path.join(root, WORKTREE_EVENTS_FILE), async () => {
    const previous = await readWorktreeStream(root), payloads = await decide(previous.creations)
    if (!payloads.length) return
    const command = randomUUID(), stream = previous.events[0]?.stream ?? randomUUID(), at = new Date().toISOString()
    const batch = payloads.map((event, index) => Envelope.parse({ version: 1, stream, sequence: previous.events.length + index + 1, id: randomUUID(), command, at, event }))
    projectWorktree([...previous.events, ...batch])
    if ((await readWorktreeStream(root)).bytes !== previous.bytes) throw new Error('Worktree creation history changed')
    const file = path.join(root, WORKTREE_EVENTS_FILE), tmp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(tmp, 'wx', 0o600)
      try { await handle.writeFile(previous.bytes + (previous.bytes && !previous.bytes.endsWith('\n') ? '\n' : '') + batch.map(event => JSON.stringify(event) + '\n').join('')); await handle.sync() } finally { await handle.close() }
      await rename(tmp, file)
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    } finally { await rm(tmp, { force: true }) }
  })
}
