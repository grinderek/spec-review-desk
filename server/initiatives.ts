import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DecisionView } from './change-view.ts'
import { loadChangeView } from './change-view.ts'
import { corpusReport } from './corpus.ts'
import { isActive } from './decision-model.ts'
import { DECISIONS_FILE, type DecisionLogEntry, parseDecisionLog } from './decisions-md.ts'
import { type ChangeRef, listChanges, type WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { BRIEF_FILE } from './initiative-brief.ts'
import { isDirty } from './git.ts'
import { INITIATIVE_FILE, type InitiativeDoc, type InputEntry, isInitiativeName, readInitiative, type Slice } from './initiative-store.ts'
import { readReview } from './review-store.ts'
import { deriveStatus, proposeBlocker, type SliceStatus } from './slice-plan.ts'

// Spec B §3: an initiative is found in any worktree of a configured repo; slice statuses are
// derived from the changes, their review.yaml, their Apply runs and the author runs.
export interface InitiativeRef { worktreeId: string; name: string; dir: string; relDir: string }
export interface InitiativeView {
  worktreeId: string
  repo: string
  branch: string | null
  worktreePath: string
  name: string
  relDir: string
  doc: InitiativeDoc
  brief: string | null
  statuses: Record<string, SliceStatus>
  blockers: Record<string, string | null>
  inputs: (InputEntry & { present: boolean })[]
  decisions: DecisionView[]
  decisionLog: DecisionLogEntry[]
  openDecisions: number
  blockingDecisions: number
  uncommitted: boolean
}
export interface InitiativeSummary {
  worktreeId: string
  repo: string
  branch: string | null
  name: string
  title: string
  planStatus: InitiativeDoc['plan']['status']
  slices: { id: string; title: string; status: SliceStatus; change: string | null }[]
  applied: number
  total: number
  openDecisions: number
  blockingDecisions: number
  running: number
}

const INITIATIVES = path.join('openspec', 'initiatives')

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function listInitiatives(wt: WorktreeInfo): Promise<InitiativeRef[]> {
  let names: string[]
  try {
    names = (await readdir(path.join(wt.path, INITIATIVES), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
  const found = await Promise.all(names.filter(isInitiativeName).map(async (name): Promise<InitiativeRef[]> => {
    const dir = path.join(wt.path, INITIATIVES, name)
    const present = await stat(path.join(dir, INITIATIVE_FILE)).then(() => true, () => false)
    return present ? [{ worktreeId: wt.id, name, dir, relDir: `openspec/initiatives/${name}` }] : []
  }))
  return found.flat()
}

export async function findInitiative(wt: WorktreeInfo, name: string): Promise<InitiativeRef> {
  const ref = (await listInitiatives(wt)).find((i) => i.name === name)
  if (!ref) throw new HttpError(404, 'unknown_initiative', `No initiative "${name}" in ${wt.path}`)
  return ref
}

async function appliedChange(wt: WorktreeInfo, ref: ChangeRef): Promise<boolean> {
  const view = await loadChangeView(wt, ref, { withCommits: false })
  const latest = view.review.apply_runs.at(-1)
  if (latest?.outcome !== 'done') return false
  return (await corpusReport(wt, view)).drift.length === 0
}

async function sliceFacts(wt: WorktreeInfo, doc: InitiativeDoc, changes: readonly ChangeRef[], slice: Slice) {
  // An author waiting for the owner still holds its slice (final review I2): the slice stays
  // proposing, so it cannot be proposed, edited or removed again until the run ends or is stopped.
  const authorRunning = doc.runs.some((r) => r.kind === 'author' && r.slice === slice.id && (r.outcome === 'running' || r.outcome === 'needs_owner'))
  const active = slice.change ? changes.find((c) => !c.archived && c.name === slice.change) : undefined
  // An archived change was applied before it was archived.
  const archived = slice.change ? changes.some((c) => c.archived && c.name.endsWith(`-${slice.change}`)) : false
  if (!active) return { authorRunning, changeExists: archived, approved: archived, applied: archived }
  const approved = (await readReview(active.dir)).approved_at !== null
  return { authorRunning, changeExists: true, approved, applied: approved && (await appliedChange(wt, active)) }
}

export async function sliceStatuses(wt: WorktreeInfo, doc: InitiativeDoc): Promise<Record<string, SliceStatus>> {
  const changes = await listChanges(wt)
  const entries = await Promise.all(doc.plan.slices.map(async (s) => [s.id, deriveStatus(s, await sliceFacts(wt, doc, changes, s))] as const))
  return Object.fromEntries(entries)
}

export async function loadInitiativeView(wt: WorktreeInfo, ref: InitiativeRef): Promise<InitiativeView> {
  const doc = await readInitiative(ref.dir)
  const statuses = await sliceStatuses(wt, doc)
  const review = await readReview(ref.dir)
  const decisionsText = await readOptional(path.join(ref.dir, DECISIONS_FILE))
  const inputs = await Promise.all(doc.inputs.map(async (i) => ({
    ...i,
    present: await stat(path.join(ref.dir, 'inputs', i.file)).then(() => true, () => false),
  })))
  return {
    worktreeId: wt.id,
    repo: wt.repo,
    branch: wt.branch,
    worktreePath: wt.path,
    name: ref.name,
    relDir: ref.relDir,
    doc,
    brief: await readOptional(path.join(ref.dir, BRIEF_FILE)),
    statuses,
    blockers: Object.fromEntries(doc.plan.slices.map((s) => [s.id, proposeBlocker(doc.plan.slices, statuses, s.id)])),
    inputs,
    decisions: review.decisions.map((d) => ({ ...d, orphaned: false })),
    decisionLog: decisionsText ? parseDecisionLog(decisionsText) : [],
    openDecisions: review.decisions.filter(isActive).length,
    blockingDecisions: review.decisions.filter((d) => d.blocking && isActive(d)).length,
    uncommitted: await isDirty(wt.path, ref.relDir),
  }
}

export function summarizeInitiative(view: InitiativeView): InitiativeSummary {
  const slices = view.doc.plan.slices.map((s) => ({ id: s.id, title: s.title, status: view.statuses[s.id] ?? 'planned', change: s.change }))
  return {
    worktreeId: view.worktreeId,
    repo: view.repo,
    branch: view.branch,
    name: view.name,
    title: view.doc.title,
    planStatus: view.doc.plan.status,
    slices,
    applied: slices.filter((s) => s.status === 'applied').length,
    total: slices.length,
    openDecisions: view.openDecisions,
    blockingDecisions: view.blockingDecisions,
    running: view.doc.runs.filter((r) => r.outcome === 'running').length,
  }
}

// Sidebar tag of a change that belongs to an initiative (spec B §3): "health-score · s3".
export async function initiativeTags(wt: WorktreeInfo): Promise<Record<string, string>> {
  const tags: Record<string, string> = {}
  for (const ref of await listInitiatives(wt)) {
    const doc = await readInitiative(ref.dir).catch(() => null)
    for (const s of doc?.plan.slices ?? []) if (s.change) tags[s.change] = `${ref.name} · ${s.id}`
  }
  return tags
}
