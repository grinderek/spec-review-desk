import { HttpError } from './errors.ts'
import { allScenarios, findPhrase, findScenario, loadChangeView } from './change-view.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { headSha } from './git.ts'
import type { Readiness } from './readiness.ts'
import { nowIso, recordApprovalEvents, withReviewLock, type ApprovalEvent, type ReviewDomainEvent, type Entry, type ReviewDoc, type Section, type Thread } from './review-store.ts'

export type ApprovalCommand =
  | { type: 'ApproveScenario' | 'RevokeScenario' | 'ApprovePhrase' | 'RevokePhrase'; key: string }
  | { type: 'RequestScenarioChanges'; key: string; reason: string; threadId: string }
  | { type: 'DropOrphanReview'; section: Section; key: string }
  | { type: 'ReattachOrphanReview'; section: Section; key: string; to: string }
  | { type: 'RecordChangeApproval' }
export interface ApprovalFacts {
  hash?: string
  commit?: string
  targetExists?: boolean
  readiness?: Readiness
  sourceVersion?: string
}

const ownEntry = (entries: Record<string, Entry>, key: string): Entry | undefined => Object.hasOwn(entries, key) ? entries[key] : undefined
function entryEvent(section: Section, key: string, entry: Entry): ApprovalEvent {
  if (section === 'scenarios') return entry.status === 'approved'
    ? { type: 'ScenarioApproved', key, entry: { ...entry, status: 'approved' } }
    : { type: 'ScenarioChangesRequested', key, entry: { ...entry, status: 'changes_requested' } }
  return entry.status === 'approved'
    ? { type: 'PhraseApproved', key, entry: { ...entry, status: 'approved' } }
    : { type: 'PhraseChangesRequested', key, entry: { ...entry, status: 'changes_requested' } }
}
const removedEvent = (section: Section, key: string): ApprovalEvent => ({ type: section === 'scenarios' ? 'ScenarioReviewRemoved' : 'PhraseReviewRemoved', key })
function requestedThread(command: Extract<ApprovalCommand, { type: 'RequestScenarioChanges' }>, at: string): Thread {
  return { id: command.threadId, anchor: 'scenario', ref: command.key, status: 'open',
    messages: [{ role: 'owner', at, text: command.reason, note: null, patch: null }] }
}

// The state passed here is replayed approval history,
// rather than an edited target ReviewDoc. Only this decision produces command events.
export function decideApproval(state: ReviewDoc, command: ApprovalCommand, facts: ApprovalFacts, at: string): ReviewDomainEvent[] {
  if (command.type === 'RecordChangeApproval') {
    if (!facts.readiness?.ready) throw new HttpError(409, 'not_ready', `Not ready: ${facts.readiness?.reasons.join('; ') ?? 'readiness unavailable'}`)
    if (!facts.commit) throw new Error('Git HEAD is required to record change approval')
    return [{ type: 'ChangeApprovalRecorded', at, commit: facts.commit }]
  }
  if (command.type === 'DropOrphanReview' || command.type === 'ReattachOrphanReview') {
    const current = ownEntry(state[command.section], command.key)
    if (command.type === 'DropOrphanReview') return current ? [removedEvent(command.section, command.key)] : []
    if (!facts.targetExists) throw new HttpError(404, 'unknown_target', `No ${command.section === 'scenarios' ? 'scenario' : 'phrase'} ${command.to}`)
    if (!current) throw new HttpError(404, 'unknown_entry', `No review entry ${command.key}`)
    if (command.key === command.to) return []
    return [removedEvent(command.section, command.key), entryEvent(command.section, command.to, current)]
  }
  const section = command.type === 'ApprovePhrase' || command.type === 'RevokePhrase' ? 'phrases' : 'scenarios'
  const current = ownEntry(state[section], command.key)
  if (command.type === 'RevokeScenario' || command.type === 'RevokePhrase') {
    return current ? [removedEvent(section, command.key)] : []
  }
  if (!facts.hash) throw new HttpError(404, section === 'scenarios' ? 'unknown_scenario' : 'unknown_phrase', `No ${section === 'scenarios' ? 'scenario' : 'phrase'} ${command.key}`)
  if (command.type === 'RequestScenarioChanges') {
    const entry = { status: 'changes_requested' as const, text_hash: facts.hash, approved_commit: null, at }
    return [{ type: 'ScenarioChangesRequested', key: command.key, entry }, { type: 'DiscussionOpened', thread: requestedThread(command, at) }]
  }
  const entry = { status: 'approved' as const, text_hash: facts.hash, approved_commit: section === 'scenarios' ? facts.commit ?? null : null, at }
  return [entryEvent(section, command.key, entry)]
}

export async function readApprovalFacts(wt: WorktreeInfo, ref: ChangeRef, command: ApprovalCommand): Promise<ApprovalFacts> {
  const view = await loadChangeView(wt, ref, { withCommits: false })
  if (command.type === 'RecordChangeApproval') return {
    readiness: view.readiness, commit: await headSha(wt.path), sourceVersion: JSON.stringify({
      scenarios: allScenarios(view).map(({ key, hash }) => ({ key, hash })),
      phrases: view.phrases.map(({ key, hash }) => ({ key, hash })), joinKey: view.joinKey, errors: view.errors,
    }),
  }
  if (command.type === 'ReattachOrphanReview') {
    const target = command.section === 'scenarios' ? findScenario(view, command.to) : findPhrase(view, command.to)
    return { targetExists: !!target, hash: target?.hash }
  }
  if (command.type === 'ApprovePhrase') return { hash: findPhrase(view, command.key)?.hash }
  if (command.type === 'ApproveScenario' || command.type === 'RequestScenarioChanges') {
    const scenario = findScenario(view, command.key)
    return { hash: scenario?.hash, ...(command.type === 'ApproveScenario' && scenario ? { commit: await headSha(wt.path) } : {}) }
  }
  return {}
}

// External effects run only here, after recording and a final source check. Replay only projects.
export async function executeApprovalCommand<T = void>(changeDir: string, command: ApprovalCommand, readFacts: () => Promise<ApprovalFacts>, afterRecord?: () => Promise<T>): Promise<T | undefined> {
  return withReviewLock(changeDir, async () => {
    let verify: () => Promise<void> = async () => undefined
    await recordApprovalEvents(changeDir, async (previous) => {
      const facts = await readFacts()
      const at = nowIso()
      const events = decideApproval(previous, command, facts, at)
      verify = async () => {
        const latest = await readFacts()
        if (JSON.stringify(latest) !== JSON.stringify(facts)) {
          throw new HttpError(409, command.type === 'ApproveScenario' ? 'scenario_changed' : 'review_source_changed', 'Review source facts changed while preparing approval. Review the current contract and retry.')
        }
      }
      return { events, verify }
    })
    if (afterRecord) { await verify(); return afterRecord() }
  })
}
