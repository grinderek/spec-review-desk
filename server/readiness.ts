import { pendingBlocking } from './decision-model.ts'
import type { PackageProblem } from './change-package.ts'
import type { DecisionRecord, Effective, Thread } from './review-store.ts'

export interface ReadinessInput {
  scenarios: readonly Effective[]
  phrases: readonly Effective[]
  threads: readonly Thread[]
  decisions: readonly Pick<DecisionRecord, 'blocking' | 'status'>[]
  packageProblems: readonly PackageProblem[]
  uncatalogued: number
  reviewValid: boolean
  pendingEffects?: number
  pendingExecutions?: number
}
export interface Readiness { ready: boolean; reasons: string[] }

const count = (n: number, singular: string, plural = `${singular}s`): string => `${n} ${n === 1 ? singular : plural}`

export function computeReadiness(input: ReadinessInput): Readiness {
  const reasons: string[] = []
  if (!input.reviewValid) reasons.push('review history is invalid')
  if (input.pendingEffects) reasons.push(`${count(input.pendingEffects, 'Git operation')} requires recovery`)
  if (input.pendingExecutions) reasons.push(`${count(input.pendingExecutions, 'reviewer execution')} requires completion or recovery`)
  if (input.packageProblems.length) reasons.push(`${count(input.packageProblems.length, 'package validation issue')} requires correction`)
  if (input.scenarios.length === 0) reasons.push('no scenarios')
  const scenarios = input.scenarios.filter((e) => e.status !== 'approved').length
  if (scenarios) reasons.push(`${count(scenarios, 'scenario')} not approved`)
  const phrases = input.phrases.filter((e) => e.status !== 'approved').length
  if (phrases) reasons.push(`${count(phrases, 'phrase')} not approved`)
  const threads = input.threads.filter((t) => t.status !== 'resolved').length
  if (threads) reasons.push(`${count(threads, 'thread')} not resolved`)
  // Spec §9: only blocking decisions that are still open or decided (not yet recorded) block.
  const blocking = pendingBlocking(input.decisions).length
  if (blocking) reasons.push(`${count(blocking, 'blocking decision')} open`)
  if (input.uncatalogued) reasons.push(count(input.uncatalogued, 'uncatalogued step'))
  return { ready: reasons.length === 0, reasons }
}
