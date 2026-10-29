import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type Catalog, emptyCatalog, makeClassifier, parseCatalog, type Phrase } from './catalog.ts'
import { loadChangePackage, type ChangeMetadata, type NativeContract, type PackageProblem } from './change-package.ts'
import { renderChangeDocumentation } from './contract-docs.ts'
import { approvalCommitProven } from './approval-proof.ts'
import { isActive } from './decision-model.ts'
import { type DecisionLogEntry, parseDecisionLog, renderDecisionLog } from './decisions-md.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { type FeatureView, type ScenarioView } from './gherkin.ts'
import { findCommitIntroducing, isDirty } from './git.ts'
import { computeReadiness, type Readiness } from './readiness.ts'
import {
  type DecisionRecord, type Effective, effectiveStatus, emptyReview, orphanKeys, readReview, REVIEW_EVENTS_FILE, type ReviewDoc, ReviewFileError,
} from './review-store.ts'

export type ScenarioWithStatus = ScenarioView & { effective: Effective }
export type FeatureWithStatus = Omit<FeatureView, 'scenarios'> & { scenarios: ScenarioWithStatus[] }
export type PhraseView = Phrase & { effective: Effective; usedBy: number }
export type DecisionView = DecisionRecord & { orphaned: boolean }

export interface ChangeView {
  worktreeId: string
  repo: string
  branch: string | null
  worktreePath: string
  name: string
  dir: string
  relDir: string
  archived: boolean
  features: FeatureWithStatus[]
  phrases: PhraseView[]
  catalogPreamble: string
  proposedPreamble: string
  metadata: ChangeMetadata | null
  validation: { valid: boolean; problems: PackageProblem[] }
  contracts: Pick<NativeContract, 'key' | 'id' | 'file' | 'title' | 'hash' | 'sourceHash'>[]
  approvalCommitted: boolean
  readiness: Readiness
  orphans: { scenarios: string[]; phrases: string[] }
  review: ReviewDoc
  decisions: DecisionView[]
  decisionLog: DecisionLogEntry[]
  reviewErrors: string[] | null
  uncommittedReview: boolean
  docs: { contracts: string; proposal: string | null; design: string | null; tasks: string | null; result: string | null; decisions: string | null }
  errors: { file: string; message: string }[]
}

export interface ChangeSummary {
  name: string
  archived: boolean
  reviewStatus: 'pending' | 'approved'
  approved: number
  total: number
  phrasesApproved: number
  phrasesTotal: number
  openThreads: number
  openDecisions: number
  blockingDecisions: number
  ready: boolean
  approvedAt: string | null
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function catalogAt(file: string): Promise<Catalog> {
  const text = await readOptional(file)
  return text ? parseCatalog(text) : emptyCatalog()
}

const commitCache = new Map<string, string | null>()

async function withCommits(root: string, relDir: string, features: FeatureView[]): Promise<FeatureView[]> {
  const lookup = async (file: string, anchor: string): Promise<string | null> => {
    const key = `${root}|${file}|${anchor}`
    if (!commitCache.has(key)) commitCache.set(key, await findCommitIntroducing(root, anchor, `${relDir}/${file}`))
    return commitCache.get(key) ?? null
  }
  return Promise.all(
    features.map(async (f) => ({
      ...f,
      scenarios: await Promise.all(
        f.scenarios.map(async (s) => ({
          ...s,
          decisions: await Promise.all(s.decisions.map(async (d) => ({ ...d, commit: await lookup(f.file, d.anchor) }))),
        })),
      ),
    })),
  )
}

export async function loadChangeView(wt: WorktreeInfo, ref: ChangeRef, opts: { withCommits?: boolean } = {}): Promise<ChangeView> {
  const approved = await catalogAt(path.join(wt.path, 'features', 'STEPS.md'))
  const proposed = await catalogAt(path.join(ref.dir, 'features', 'NEW_STEPS.md'))
  const classify = makeClassifier(approved, proposed)
  const relDir = toPosix(path.relative(wt.path, ref.dir))

  const change = await loadChangePackage(ref.dir, { approvedCatalog: approved, classify })
  const features = opts.withCommits === false ? change.features : await withCommits(wt.path, relDir, change.features)
  const errors = change.problems.map(({ file, message }) => ({ file, message }))

  let review: ReviewDoc = emptyReview()
  let reviewErrors: string[] | null = null
  try {
    review = await readReview(ref.dir)
  } catch (error) {
    if (!(error instanceof ReviewFileError)) throw error
    reviewErrors = error.issues
  }

  const withStatus: FeatureWithStatus[] = features.map((f) => ({
    ...f,
    scenarios: f.scenarios.map((s) => ({ ...s, effective: effectiveStatus(review.scenarios[s.key], s.hash) })),
  }))
  const scenarios = withStatus.flatMap((f) => f.scenarios)
  const steps = [...features.flatMap((f) => f.background), ...scenarios.flatMap((s) => s.steps)]
  const phrases: PhraseView[] = proposed.phrases.map((p) => ({
    ...p,
    effective: effectiveStatus(review.phrases[p.key], p.hash),
    usedBy: p.kind === 'phrase' ? steps.filter((s) => s.phrase === p.phrase).length : 0,
  }))

  const scenarioKeys = new Set(scenarios.map((s) => s.key))
  const decisions: DecisionView[] = review.decisions.map((d) => ({
    ...d,
    orphaned: d.scope.kind === 'scenario' && isActive(d) && !scenarioKeys.has(d.scope.key),
  }))
  const decisionsText = renderDecisionLog(review, ref.name)
  const contracts = change.contracts.map(({ key, id, file, title, hash, sourceHash }) => ({ key, id, file, title, hash, sourceHash }))
  const validation = { valid: change.valid, problems: change.problems }
  const readiness = computeReadiness({
    scenarios: scenarios.map((s) => s.effective),
    threads: review.threads.filter((t) => t.anchor !== 'apply'),
    decisions: review.decisions,
    packageProblems: change.problems,
    uncatalogued: steps.filter((s) => s.kind === 'uncatalogued').length,
    reviewValid: reviewErrors === null,
    pendingEffects: review.git_effects.filter(e => ['requested', 'pending', 'uncertain'].includes(e.status)).length,
    pendingExecutions: review.executions.filter(run => run.request.role === 'reviewer' && ['queued', 'running', 'uncertain'].includes(run.outcome)).length,
  })

  return {
    worktreeId: wt.id,
    repo: wt.repo,
    branch: wt.branch,
    worktreePath: wt.path,
    name: ref.name,
    dir: ref.dir,
    relDir,
    archived: ref.archived,
    features: withStatus,
    phrases,
    catalogPreamble: approved.preamble,
    proposedPreamble: proposed.preamble,
    metadata: change.metadata,
    validation,
    contracts,
    approvalCommitted: approvalCommitProven({ contracts, metadata: change.metadata, validation, phrases, review }),
    readiness,
    orphans: orphanKeys(review, scenarios.map((s) => s.key), proposed.phrases.map((p) => p.key)),
    review,
    decisions,
    decisionLog: decisionsText ? parseDecisionLog(decisionsText) : [],
    reviewErrors,
    uncommittedReview: await isDirty(wt.path, `${relDir}/${REVIEW_EVENTS_FILE}`),
    docs: {
      contracts: renderChangeDocumentation(change),
      proposal: await readOptional(path.join(ref.dir, 'proposal.md')),
      design: await readOptional(path.join(ref.dir, 'design.md')),
      tasks: await readOptional(path.join(ref.dir, 'tasks.md')),
      result: await readOptional(path.join(ref.dir, 'RESULT.md')),
      decisions: decisionsText,
    },
    errors,
  }
}

export const allScenarios = (view: ChangeView): ScenarioWithStatus[] => view.features.flatMap((f) => f.scenarios)
export const findScenario = (view: ChangeView, key: string): ScenarioWithStatus | undefined => allScenarios(view).find((s) => s.key === key)
export const findPhrase = (view: ChangeView, key: string): PhraseView | undefined => view.phrases.find((p) => p.key === key)

export function summarize(view: ChangeView): ChangeSummary {
  const scenarios = allScenarios(view)
  return {
    name: view.name,
    archived: view.archived,
    reviewStatus: view.readiness.ready && view.approvalCommitted ? 'approved' : 'pending',
    approved: scenarios.filter((s) => s.effective.status === 'approved').length,
    total: scenarios.length,
    phrasesApproved: view.phrases.filter((p) => p.effective.status === 'approved').length,
    phrasesTotal: view.phrases.length,
    openThreads: view.review.threads.filter((t) => t.status !== 'resolved' && t.anchor !== 'apply').length,
    openDecisions: view.decisions.filter(isActive).length,
    blockingDecisions: view.decisions.filter((d) => d.blocking && isActive(d)).length,
    ready: view.readiness.ready,
    approvedAt: view.review.approved_at,
  }
}
