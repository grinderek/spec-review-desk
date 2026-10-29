import { z } from 'zod'
import { RoutingDecisionSchema } from './agent-routing.ts'
import { ExecutionRunSchema } from './execution-model.ts'
import { InitiativeOwnerGitStateSchema } from './initiative-owner-effect-model.ts'

// desk/initiatives/<name>/initiative.yaml (spec B §3). Slice statuses are derived, never stored.
export const INITIATIVE_FILE = 'initiative.yaml'
export const INITIATIVE_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/
// Every persisted field that becomes a filesystem path (or a path-shaped argv) is constrained here,
// so a hand-edited, merged or corrupted initiative.yaml fails as 409 review_invalid instead of
// driving a read, copy or recursive delete outside its directory (final review I4).
export const RUN_ID = /^r_[0-9a-f]{8}$/
export const CHANGE_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/
// A sanitized input name (inputs.ts sanitizeInputName): a plain basename, no "/", no leading dot.
export const INPUT_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/
export const runLogPath = (id: string): string => `.spec-review/runs/${id}.ndjson`

export const ExistingProcessSchema = z.object({
  product: z.string().min(1), process: z.string().trim().min(1).max(200),
  boundary: z.string().trim().min(1).max(4000), snapshot: z.literal('implementation-snapshot.json'),
}).strict()
const InputSourceSchema = z.union([
  z.object({ kind: z.literal('implementation'), product: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('upload') }).strict(),
  z.object({ kind: z.literal('repo'), path: z.string(), commit: z.string() }).strict(),
  z.object({ kind: z.literal('research'), run: z.string().regex(RUN_ID), domains: z.array(z.string()).default([]) }).strict(),
])
export const InputSchema = z.object({
  file: z.string().regex(INPUT_FILE),
  bytes: z.number().int().nonnegative(),
  blob: z.string().regex(/^[0-9a-f]{64}$/),
  source: InputSourceSchema,
  added_at: z.string(),
  // A research document stays a draft - excluded from every room - until the owner accepts it.
  draft: z.boolean().default(false),
}).strict()
export const SliceSchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.string(),
  depends_on: z.array(z.string()).default([]),
  change: z.string().regex(CHANGE_NAME).nullable().default(null),
})
export const RunSchema = z.object({
  id: z.string().regex(RUN_ID),
  execution_id: z.uuid(),
  kind: z.enum(['research', 'planner', 'author']),
  slice: z.string().nullable().default(null),
  topic: z.string().nullable().default(null),
  session: z.string().regex(SESSION_ID),
  container: z.string(),
  log: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  outcome: z.enum(['queued', 'running', 'done', 'needs_owner', 'failed', 'stopped', 'uncertain']),
  notes: z.string().nullable().default(null),
  // Research only: the owner's questions and the phase (search: WebSearch only; read: after the
  // fetch-domains decision) and whether WebFetch is enabled in the read phase.
  questions: z.string().optional(),
  phase: z.enum(['search', 'read']).optional(),
  web_fetch: z.boolean().optional(),
  // The domains the run's reading attempts could reach (union over its read phases): the draft's
  // provenance, also after the owner stopped reading.
  read_domains: z.array(z.string()).optional(),
  // Author only: the change name the author must write.
  change: z.string().regex(CHANGE_NAME).optional(),
  // The one validation retry of sub-project A §4 is running (cleared by an owner resume).
  validation_retry: z.boolean().optional(),
  routing: RoutingDecisionSchema.optional(),
  // Validation or vetting problems of a failed run.
  problems: z.array(z.string()).optional(),
}).refine((run) => run.log === runLogPath(run.id), { path: ['log'], message: 'must be .spec-review/runs/<run id>.ndjson' })
export const InitiativeSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(INITIATIVE_NAME),
  title: z.string().min(1),
  repo: z.string().min(1),
  created_at: z.string(),
  existingProcess: ExistingProcessSchema.optional(),
  inputs: z.array(InputSchema).default([]),
  research: z.object({ domains: z.array(z.string()).default([]) }).default({ domains: [] }),
  plan: z
    .object({
      status: z.enum(['none', 'draft', 'approved']).default('none'),
      approved_at: z.string().nullable().default(null),
      slices: z.array(SliceSchema).default([]),
    })
    .default({ status: 'none', approved_at: null, slices: [] }),
  runs: z.array(RunSchema).default([]),
  executions: z.array(ExecutionRunSchema).default([]),
  git_effects: z.array(InitiativeOwnerGitStateSchema).default([]),
})

export type InitiativeDoc = z.infer<typeof InitiativeSchema>
export type InputEntry = z.infer<typeof InputSchema>
export type Slice = z.infer<typeof SliceSchema>
export type RunRecord = z.infer<typeof RunSchema>
export type RunKind = RunRecord['kind']
export type Plan = InitiativeDoc['plan']
