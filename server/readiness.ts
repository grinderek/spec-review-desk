import type { JoinKeyReport } from './joinkey.ts'
import type { DecisionRecord, Effective, Thread } from './review-store.ts'

export interface ReadinessInput {
  scenarios: readonly Effective[]
  phrases: readonly Effective[]
  threads: readonly Thread[]
  decisions: readonly Pick<DecisionRecord, 'blocking' | 'status'>[]
  joinKey: JoinKeyReport
  uncatalogued: number
  parseErrors: number
  reviewValid: boolean
}
export interface Readiness { ready: boolean; reasons: string[] }

const count = (n: number, singular: string, plural = `${singular}s`): string => `${n} ${n === 1 ? singular : plural}`

export function computeReadiness(input: ReadinessInput): Readiness {
  const reasons: string[] = []
  if (!input.reviewValid) reasons.push('review.yaml is invalid')
  if (input.parseErrors) reasons.push(`${count(input.parseErrors, 'file')} failed to parse`)
  if (input.scenarios.length === 0) reasons.push('no scenarios')
  const scenarios = input.scenarios.filter((e) => e.status !== 'approved').length
  if (scenarios) reasons.push(`${count(scenarios, 'scenario')} not approved`)
  const phrases = input.phrases.filter((e) => e.status !== 'approved').length
  if (phrases) reasons.push(`${count(phrases, 'phrase')} not approved`)
  const threads = input.threads.filter((t) => t.status !== 'resolved').length
  if (threads) reasons.push(`${count(threads, 'thread')} not resolved`)
  // Spec §9: only blocking decisions that are still open or decided (not yet recorded) block.
  const blocking = input.decisions.filter((d) => d.blocking && (d.status === 'open' || d.status === 'decided')).length
  if (blocking) reasons.push(`${count(blocking, 'blocking decision')} open`)
  if (!input.joinKey.ok) {
    const j = input.joinKey
    reasons.push(
      `join key: ${count(j.missingInFeatures.length, 'spec title')} without a scenario, ` +
        `${count(j.missingInSpecs.length, 'scenario')} without a spec line, ` +
        `${count(j.duplicateTitles.length, 'duplicate title')}`,
    )
  }
  if (input.uncatalogued) reasons.push(count(input.uncatalogued, 'uncatalogued step'))
  return { ready: reasons.length === 0, reasons }
}
