import { allScenarios, type ChangeView, findPhrase, findScenario, loadChangeView } from './change-view.ts'
import type { CodexOutcome } from './codex.ts'
import { DECISIONS_FILE } from './decisions-md.ts'
import type { ChangeRef, WorktreeInfo } from './discovery.ts'
import { checkPatch, disallowedPatchContent, patchPaths, touchedPaths, validatePatchPaths } from './patch.ts'
import {
  type AgentKind, type AgentReply, parseReply, type ReplyContext, validateReply,
} from './protocol.ts'
import {
  type Message, nowIso, type Patch, REVIEW_EVENTS_FILE, REVIEW_FILE, type Thread,
} from './review-store.ts'

export const QUESTION_TOOLS = { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch'] }

export const ownerMessage = (text: string, at: Date = new Date()): Message => ({ role: 'owner', at: nowIso(at), text, note: null, patch: null })

export async function vetPatch(cwd: string, relDir: string, diff: string): Promise<Patch> {
  // Content checks first, and pure (no git call needed): a CRLF or binary/mode violation must
  // never even reach `git apply --numstat`, whose interpretation of such input isn't something
  // this code relies on.
  const contentError = disallowedPatchContent(diff)
  if (contentError) return { diff, state: 'stale', commit: null, error: contentError, files: patchPaths(diff) }
  const files = await touchedPaths(cwd, diff)
  const reviewFile = `${relDir}/${REVIEW_FILE}`
  const reviewEvents = `${relDir}/${REVIEW_EVENTS_FILE}`
  if (files.includes(reviewEvents)) return { diff, state: 'stale', commit: null, error: `a patch may not touch ${reviewEvents} — it is written by the Desk itself`, files }
  if (files.includes(reviewFile)) {
    return { diff, state: 'stale', commit: null, error: `a patch may not touch ${reviewFile} — it is written by the apply route itself`, files }
  }
  // Final review Minor 2: reviewer.md tells the question agent it may never touch decisions.md
  // (the Desk writes it, spec §6) — enforce that the same way review.yaml is enforced, so a
  // forged history entry can never reach it through a patch.
  const decisionsFile = `${relDir}/${DECISIONS_FILE}`
  if (files.includes(decisionsFile)) {
    return { diff, state: 'stale', commit: null, error: `a patch may not touch ${decisionsFile} — it is written by the Desk itself`, files }
  }
  const pathErrors = validatePatchPaths(files, relDir)
  if (pathErrors.length) return { diff, state: 'stale', commit: null, error: pathErrors.join('; '), files }
  const checkError = await checkPatch(cwd, diff)
  return { diff, state: checkError ? 'stale' : 'proposed', commit: null, error: checkError, files }
}

export function anchorText(view: ChangeView, anchor: Thread['anchor'], ref: string): string {
  if (anchor === 'scenario') return findScenario(view, ref)?.source ?? `(the scenario "${ref}" no longer exists)`
  if (anchor === 'phrase') {
    const phrase = findPhrase(view, ref)
    return phrase ? `${phrase.keyword ?? ''} \`${phrase.phrase}\` ${phrase.note}\nMeaning: ${phrase.meaning}`.trim() : `(the phrase "${ref}" no longer exists)`
  }
  return view.docs.proposal ?? '(no proposal.md)'
}

export function reviewFiles(view: ChangeView): string[] {
  return [
    ...view.features.map((f) => `${view.relDir}/${f.file}`),
    `${view.relDir}/features/NEW_STEPS.md`,
    'features/STEPS.md',
    `${view.relDir}/proposal.md`,
    `${view.relDir}/specs/`,
    `${view.relDir}/${DECISIONS_FILE}`,
  ]
}

export function replyContext(agent: AgentKind, view: ChangeView): ReplyContext {
  return { agent, scenarioKeys: allScenarios(view).map((s) => s.key), decisions: view.review.decisions }
}

export interface CheckedReply { reply: AgentReply | null; issues: string[]; raw: string }

export async function checkReply(wt: WorktreeInfo, ref: ChangeRef, agent: AgentKind, outcome: CodexOutcome): Promise<CheckedReply> {
  const raw = outcome.structured === null || outcome.structured === undefined ? outcome.text : JSON.stringify(outcome.structured, null, 2)
  const parsed = parseReply(outcome.structured)
  if (!parsed.reply) return { reply: null, issues: parsed.issues, raw }
  const issues = validateReply(parsed.reply, replyContext(agent, await loadChangeView(wt, ref, { withCommits: false })))
  return { reply: issues.length ? null : parsed.reply, issues, raw }
}

export { QuestionService } from './question-execution.ts'
