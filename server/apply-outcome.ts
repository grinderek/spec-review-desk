import { type ClaudeEvent, parseStreamLine, type ResultEvent } from './claude.ts'
import { type AgentReply, parseJsonObject, parseReply } from './protocol.ts'
import type { ApplyRun } from './review-store.ts'

// Kept for one release (spec §8/§13): a run without a structured reply still reads this line.
export const NEEDS_OWNER = /^NEEDS_OWNER:\s*(.+)$/m

export interface ApplyOutcome {
  outcome: ApplyRun['outcome']
  text: string
  reply: AgentReply | null
  issues: string[]
  raw: string | null
}

const STATUS_OUTCOME: Record<AgentReply['status'], ApplyRun['outcome']> = {
  done: 'done',
  needs_owner: 'needs_owner',
  failed: 'failed',
  answered: 'failed',
}

export const readEvents = (text: string): ClaudeEvent[] =>
  text.split('\n').flatMap((line) => {
    const event = parseStreamLine(line)
    return event ? [event] : []
  })

const lastResult = (events: readonly ClaudeEvent[]): ResultEvent | undefined =>
  [...events].reverse().find((e): e is ResultEvent => e.type === 'result')
const narration = (events: readonly ClaudeEvent[]): string => events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')

export function outcomeOf(events: readonly ClaudeEvent[], stopping: boolean): ApplyOutcome {
  const result = lastResult(events)
  const text = result?.text || narration(events)
  const none = { reply: null, issues: [] as string[], raw: null }
  if (stopping) return { outcome: 'stopped', text: text || 'Stopped by the owner.', ...none }
  if (!result || !result.ok) return { outcome: 'failed', text: text || 'The apply run ended without a result.', ...none }
  const structured = result.structured ?? parseJsonObject(result.text)
  if (structured === null || structured === undefined) {
    return { outcome: NEEDS_OWNER.test(result.text) ? 'needs_owner' : 'done', text: result.text, ...none }
  }
  const raw = JSON.stringify(structured, null, 2)
  const parsed = parseReply(structured)
  if (!parsed.reply) return { outcome: 'failed', text: "The Apply agent's reply did not pass validation.", reply: null, issues: parsed.issues, raw }
  return { outcome: STATUS_OUTCOME[parsed.reply.status], text: parsed.reply.answer, reply: parsed.reply, issues: [], raw }
}

export function logText(events: readonly ClaudeEvent[]): string {
  const streamed = narration(events)
  const result = lastResult(events)
  const answer = result ? parseReply(result.structured ?? parseJsonObject(result.text)).reply?.answer : undefined
  return answer ? `${streamed}${streamed ? '\n\n' : ''}${answer}` : streamed
}
