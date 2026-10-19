import { decideOwnerDecision, projectOwnerDecision } from './decision-commands.ts'
import { type DecisionChoiceInput, findDecision } from './decision-model.ts'
import { HttpError } from './errors.ts'
import { assertWorktreeAdmission } from './execution-admission.ts'
import { executeGitEffect, prepareGitEffect, withGitEffectLock } from './git-effect.ts'
import { commitMessage } from './patch.ts'
import { requestReviewEffect, reviewEffectReceipt } from './review-effects.ts'
import { type DecisionRecord, nowIso, readReview, recordReviewEvents, REVIEW_EVENTS_FILE, REVIEW_FILE, type ReviewDoc, withReviewLock } from './review-store.ts'

export const DECISIONS_FILE = 'decisions.md'
export interface DecisionLogEntry { date: string; question: string; decision: string; note: string; source: string; id: string | null }
const HEADING = /^## (\d{4}-\d{2}-\d{2}) - (.+)$/
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const orEmpty = (value: string): string => value === '-' ? '' : value
export function sourceLabel(source: DecisionRecord['source']): string {
  if (source.kind === 'thread') return `thread ${source.id}`
  if (source.kind === 'apply') return `apply run ${source.run}`
  if (source.kind === 'run') return `${source.agent} run ${source.run}`
  return 'owner'
}
export function renderDecisionEntry(d: DecisionRecord, date: string): string {
  const option = d.options.find(o => o.id === d.choice?.option)
  return [`## ${date} - ${oneLine(d.question)}`, `Decision: ${option ? `${oneLine(option.label)} - ${oneLine(option.consequence)}` : '-'}`,
    `Note: ${d.choice?.note ? oneLine(d.choice.note) : '-'}`, `Source: ${sourceLabel(d.source)} · ${d.id}`, ''].join('\n')
}
// decisions.md projects confirmed choices; one selected pending choice is rendered for its Git intent.
export function renderDecisionLog(doc: ReviewDoc, name: string, pendingId?: string): string {
  const entries = doc.decisions.filter(d => d.scope.kind === 'change' && d.choice &&
    ((d.status === 'recorded' && d.recorded?.how === 'decisions_md') || (d.id === pendingId && d.status === 'decided')))
  return `# Owner decisions - ${name}\n\n` + entries.map(d => renderDecisionEntry(d, d.choice!.at.slice(0, 10))).join('\n')
}
export function parseDecisionLog(text: string): DecisionLogEntry[] {
  const lines = text.split('\n')
  const starts = lines.flatMap((line, i) => HEADING.test(line) ? [i] : [])
  return starts.map((start, n) => {
    const body = lines.slice(start + 1, starts[n + 1] ?? lines.length)
    const field = (name: string): string => body.find(l => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? ''
    const heading = HEADING.exec(lines[start]!)!
    const source = field('Source')
    return { date: heading[1]!, question: heading[2]!.trim(), decision: orEmpty(field('Decision')), note: orEmpty(field('Note')), source, id: /· (d_[0-9a-f]+)$/.exec(source)?.[1] ?? null }
  })
}
export function decisionCommitMessage(name: string, question: string, trailer: string): string {
  const line = oneLine(question)
  return commitMessage(name, line.length > 60 ? `${line.slice(0, 59)}...` : line, trailer)
}
export interface ChangeDecisionInput {
  cwd: string; relDir: string; changeDir: string; changeName: string; decisionId: string
  choice: DecisionChoiceInput; trailer: string; now: Date
}
// Only an explicit command retries a pending effect. Replay never chooses or starts a commit.
export function commitChangeDecision(input: ChangeDecisionInput): Promise<{ commit: string }> {
  return withGitEffectLock(input.cwd, () => withReviewLock(input.changeDir, async () => {
    const doc = await readReview(input.changeDir)
    const record = findDecision(doc, input.decisionId)
    if (record.scope.kind !== 'change') throw new HttpError(409, 'not_change_scoped', 'This decision is recorded by a scenario patch')
    const choice = { option: input.choice.option, note: input.choice.note.trim() }
    if (record.status !== 'open' && (!record.choice || record.choice.option !== choice.option || record.choice.note !== choice.note)) throw new HttpError(409, 'decision_choice_fixed', 'This decision already has a different owner choice')
    if (record.status === 'recorded' && record.recorded?.commit) return { commit: record.recorded.commit }
    if (record.status !== 'open' && record.status !== 'decided') throw new HttpError(409, 'decision_closed', 'This decision is closed')
    let plan = doc.git_effects.findLast(e => e.plan.purpose.kind === 'record-decision' && e.plan.purpose.ref === record.id && e.status !== 'failed' && e.status !== 'completed')?.plan
    await assertWorktreeAdmission(input.cwd, { operation: 'git', effectId: plan?.effectId })
    if (!plan) {
      await recordReviewEvents(input.changeDir, async previous => {
        const events = record.status === 'open' ? decideOwnerDecision(previous, { type: 'ChooseOwnerDecision', id: record.id, choice, at: nowIso(input.now) }) : []
        const decided = structuredClone(previous)
        for (const event of events) projectOwnerDecision(decided, event)
        plan = await prepareGitEffect(input.cwd, { purpose: { kind: 'record-decision', ref: record.id },
          extraFiles: [`${input.relDir}/${REVIEW_FILE}`, `${input.relDir}/${REVIEW_EVENTS_FILE}`],
          outputs: [{ path: `${input.relDir}/${DECISIONS_FILE}`, content: Buffer.from(renderDecisionLog(decided, input.changeName, record.id)) }],
          message: decisionCommitMessage(input.changeName, record.question, input.trailer) })
        return { events: [...events, ...requestReviewEffect(previous, plan)] }
      }, 'decision-command')
    }
    await recordReviewEvents(input.changeDir, async () => ({ events: [] }), 'decision-command')
    const receipt = await executeGitEffect(input.cwd, plan!, { resumePending: true })
    await recordReviewEvents(input.changeDir, async previous => ({ events: reviewEffectReceipt(previous, receipt, (state, commit) =>
      decideOwnerDecision(state, { type: 'RecordOwnerDecision', id: record.id, recorded: { how: 'decisions_md', commit } })) }), 'decision-command')
    if (receipt.status !== 'completed') throw new HttpError(receipt.status === 'uncertain' ? 409 : 500, `git_effect_${receipt.status}`, receipt.reason)
    return { commit: receipt.commit }
  }))
}
