import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { decideDecision, type DecisionChoiceInput, findDecision, recordDecision, setRecordedCommit } from './decision-model.ts'
import { HttpError } from './errors.ts'
import { commitFiles, resetStaged } from './git.ts'
import { commitMessage } from './patch.ts'
import { type DecisionRecord, nowIso, readReview, REVIEW_FILE, withReviewLock, writeReview } from './review-store.ts'

// A decision scoped to the whole change is recorded by the Desk itself in <change>/decisions.md
// (spec §6), committed together with review.yaml.
export const DECISIONS_FILE = 'decisions.md'
export interface DecisionLogEntry { date: string; question: string; decision: string; note: string; source: string; id: string | null }

const HEADING = /^## (\d{4}-\d{2}-\d{2}) — (.+)$/
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const orEmpty = (value: string): string => (value === '—' ? '' : value)

export function sourceLabel(source: DecisionRecord['source']): string {
  if (source.kind === 'thread') return `thread ${source.id}`
  if (source.kind === 'apply') return `apply run ${source.run}`
  return 'owner'
}

export function renderDecisionEntry(d: DecisionRecord, date: string): string {
  const option = d.options.find((o) => o.id === d.choice?.option)
  return [
    `## ${date} — ${oneLine(d.question)}`,
    `Decision: ${option ? `${oneLine(option.label)} — ${oneLine(option.consequence)}` : '—'}`,
    `Note: ${d.choice?.note ? oneLine(d.choice.note) : '—'}`,
    `Source: ${sourceLabel(d.source)} · ${d.id}`,
    '',
  ].join('\n')
}

export function appendDecisionEntry(existing: string | null, changeName: string, entry: string): string {
  const base = existing ?? `# Owner decisions — ${changeName}\n`
  const separated = base.endsWith('\n\n') ? base : base.endsWith('\n') ? `${base}\n` : `${base}\n\n`
  return `${separated}${entry}`
}

export function parseDecisionLog(text: string): DecisionLogEntry[] {
  const lines = text.split('\n')
  const starts = lines.flatMap((line, i) => (HEADING.test(line) ? [i] : []))
  return starts.map((start, n) => {
    const body = lines.slice(start + 1, starts[n + 1] ?? lines.length)
    const field = (name: string): string => body.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? ''
    const heading = HEADING.exec(lines[start]!)!
    const source = field('Source')
    return {
      date: heading[1]!,
      question: heading[2]!.trim(),
      decision: orEmpty(field('Decision')),
      note: orEmpty(field('Note')),
      source,
      id: /· (d_[0-9a-f]+)$/.exec(source)?.[1] ?? null,
    }
  })
}

export function decisionCommitMessage(changeName: string, question: string, trailer: string): string {
  const line = oneLine(question)
  return commitMessage(changeName, line.length > 60 ? `${line.slice(0, 59)}…` : line, trailer)
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function restore(file: string, content: string | null): Promise<void> {
  if (content === null) await rm(file, { force: true })
  else await writeFile(file, content)
}

export interface ChangeDecisionInput {
  cwd: string
  relDir: string
  changeDir: string
  changeName: string
  decisionId: string
  choice: DecisionChoiceInput
  trailer: string
  now: Date
}

// Runs entirely under the change's review lock (readReview/writeReview directly — updateReview
// would wait on the lock this call already holds).
export function commitChangeDecision(input: ChangeDecisionInput): Promise<{ commit: string }> {
  return withReviewLock(input.changeDir, async () => {
    const mdFile = path.join(input.changeDir, DECISIONS_FILE)
    const reviewFile = path.join(input.changeDir, REVIEW_FILE)
    const doc = await readReview(input.changeDir)
    if (findDecision(doc, input.decisionId).scope.kind !== 'change') {
      throw new HttpError(409, 'not_change_scoped', `Decision ${input.decisionId} is scoped to a scenario — it is recorded by a patch`)
    }
    const at = nowIso(input.now)
    const decided = decideDecision(doc, input.decisionId, input.choice, at)
    const record = findDecision(decided, input.decisionId)
    const beforeMd = await readOptional(mdFile)
    const beforeReview = await readOptional(reviewFile)
    const files = [`${input.relDir}/${DECISIONS_FILE}`, `${input.relDir}/${REVIEW_FILE}`]
    let commit: string
    try {
      await writeFile(mdFile, appendDecisionEntry(beforeMd, input.changeName, renderDecisionEntry(record, at.slice(0, 10))))
      await writeReview(input.changeDir, recordDecision(decided, input.decisionId, { how: 'decisions_md', commit: null }))
      commit = await commitFiles(input.cwd, files, decisionCommitMessage(input.changeName, record.question, input.trailer))
    } catch (error) {
      await resetStaged(input.cwd, files).catch(() => undefined)
      await restore(mdFile, beforeMd)
      await restore(reviewFile, beforeReview)
      throw error
    }
    await writeReview(input.changeDir, setRecordedCommit(await readReview(input.changeDir), input.decisionId, commit))
    return { commit }
  })
}
