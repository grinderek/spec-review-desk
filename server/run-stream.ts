import { appendFile } from 'node:fs/promises'
import { StructuredStream } from './answer-reader.ts'
import { CodexStream, type ResultEvent } from './codex.ts'
import type { EventBus } from './events.ts'
import type { Sandbox, SandboxOutcome, SandboxRun } from './sandbox.ts'
import { findSecretsInLine, maskDeep, type SecretDetector, SecretHoldback } from './secret-scan.ts'

// One sandbox attempt's stream (spec B §5.2/§10), split out of run-service.ts: what is persisted
// to the run log, what is published live, and whether a secret was seen.

// The run's own persisted log format (review round 3, finding 1): only holdback-released, already-
// redacted text for the free-text channels (narration, thinking, the reconstructed answer), plus
// text-free structural markers — never a raw stream-json line, and never the result's raw text or
// structured payload (that lives only in memory for #finish, via the captured ResultEvent). Every
// entry is masked as a whole before it is written (review round 4). `attempt` and `answer_reset`
// mark where a new answer starts, so logText() serves only the latest one.
export type LogEntry =
  | { type: 'delta' | 'thinking' | 'answer'; text: string }
  | { type: 'attempt'; resume: boolean }
  | { type: 'answer_reset' }
  | { type: 'init'; sessionId: string }
  | { type: 'message_start' }
  | { type: 'tool_start'; index: number; name: string }
  | { type: 'result'; ok: boolean; sessionId: string; numTurns: number }
interface RawStreamLine { type?: string; event?: { type?: string; delta?: { type?: string; thinking?: unknown } } }

// codex.ts's CodexEvent model has no `thinking` variant (nothing outside this file ever needed
// it); extracting it locally, straight off the raw line, avoids widening that shared model just for
// a channel this file redacts and never surfaces anywhere else (review round 3).
function thinkingDeltaText(line: string): string | null {
  let parsed: RawStreamLine
  try {
    parsed = JSON.parse(line) as RawStreamLine
  } catch {
    return null
  }
  const inner = parsed.event
  return inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string'
    ? inner.delta.thinking
    : null
}

export interface AttemptStream {
  sandbox: Sandbox
  bus: EventBus
  token: string | null
  detector: SecretDetector
  channel: string
  logFile: string
  resume: boolean
  timeoutMs: number
  spec: SandboxRun
}
export interface AttemptResult { outcome: SandboxOutcome; resultEvent: ResultEvent | null; sawSecret: boolean }

export async function streamAttempt({ sandbox, bus, token, detector, channel, logFile, resume, timeoutMs, spec }: AttemptStream): Promise<AttemptResult> {
  const stream = new StructuredStream()
  const codex = new CodexStream()
  let writes: Promise<void> = Promise.resolve()
  // Spec §5.2/§10: the token must never sit unredacted on disk or reach the UI live, even for the
  // seconds before the attempt ends, and never reassembled from many small pieces that no single
  // line or fragment carries in full (review finding 1, rounds 2–3). Free-text channels (narration,
  // thinking, the reconstructed answer) never reach the log or the bus raw: each is fed through its
  // own SecretHoldback and only its holdback-released, already-redacted output is persisted/
  // published. Raw json_delta fragments are never logged or published at all — their only
  // legitimate use is feeding the answer reconstruction below. The result event's raw text/
  // structured payload is captured in memory only (for #finish) and is never itself logged or
  // published — only its non-text metadata is. Detection (sawSecret) additionally decodes each raw
  // line's JSON string values before scanning, so a \u-escaped secret cannot evade it.
  let sawSecret = false
  let resultEvent: ResultEvent | null = null
  const narration = new SecretHoldback(token)
  const thinking = new SecretHoldback(token)
  let answer = new SecretHoldback(token)
  // Every object written or published is masked as a whole — all its string values, not just the
  // free-text ones (a tool name or session id can carry the token too, review round 4).
  const masked = <T>(value: T): T => {
    const result = maskDeep(value, token)
    if (result.secret) sawSecret = true
    return result.value
  }
  const persist = (entry: LogEntry): void => {
    const safe = masked(entry)
    writes = writes.then(() => appendFile(logFile, `${JSON.stringify(safe)}\n`))
  }
  const publish = (event: object): void => {
    bus.publish(channel, { type: 'event', event: masked(event) })
  }
  const releaseNarration = (safe: string): void => {
    if (!safe) return
    persist({ type: 'delta', text: safe })
    publish({ type: 'delta', text: safe })
  }
  const releaseThinking = (safe: string): void => {
    if (safe) persist({ type: 'thinking', text: safe })
  }
  const releaseAnswer = (safe: string): void => {
    if (!safe) return
    persist({ type: 'answer', text: safe })
    publish({ type: 'answer_delta', text: safe })
  }
  persist({ type: 'attempt', resume })
  const outcome = await sandbox.run(
    spec,
    {
      timeoutMs,
      onLine: (line) => {
        if (findSecretsInLine(line, token).length) sawSecret = true
        const events = codex.feed(line)
        if (!events.length) {
          const text = thinkingDeltaText(line)
          if (text === null) return
          detector.feed(text)
          releaseThinking(thinking.push(text))
          return
        }
        for (const event of events) {
          if (event.type === 'delta') {
            detector.feed(event.text)
            releaseNarration(narration.push(event.text))
          } else if (event.type === 'result') {
            resultEvent = event
            detector.feed(event.sessionId)
            const meta = { type: 'result' as const, ok: event.ok, sessionId: event.sessionId, numTurns: event.numTurns }
            persist(meta)
            publish(meta)
          } else if (event.type === 'init' || event.type === 'message_start' || event.type === 'tool_start') {
            // Every string that reaches the log or the bus feeds the detector, in stream order
            // (round 5). Raw json_delta does not: the decoded answer_delta below is the answer's
            // text — raw JSON would feed it twice and can hide pieces behind \u escapes.
            if (event.type === 'init') detector.feed(event.sessionId)
            if (event.type === 'tool_start') detector.feed(event.name)
            persist(event)
            publish(event)
          }
          for (const derived of stream.feed(event)) {
            if (derived.type === 'answer_delta') {
              detector.feed(derived.text)
              releaseAnswer(answer.push(derived.text))
            } else if (derived.type === 'answer_reset') {
              answer.flush() // the superseded draft is dropped unreleased, but still scanned
              if (answer.sawSecret) sawSecret = true
              answer = new SecretHoldback(token)
              persist(derived)
              publish(derived)
            }
          }
        }
      },
    },
  )
  // flush() masks a partial token a stop or timeout cut off mid-stream and reports it (finding 2).
  releaseNarration(narration.flush())
  releaseThinking(thinking.flush())
  releaseAnswer(answer.flush())
  if (narration.sawSecret || thinking.sawSecret || answer.sawSecret || detector.sawSecret) sawSecret = true
  await writes
  return { outcome, resultEvent, sawSecret }
}

// The run log as the owner reads it: the narration plus only the latest answer — a validation
// retry, an owner resume or an answer_reset starts a new one (review round 4, finding 4); an
// attempt that streamed no answer keeps the previous one.
export function logText(raw: string): string {
  const entries = raw.split('\n').flatMap((line): LogEntry[] => {
    if (!line) return []
    try {
      return [JSON.parse(line) as LogEntry]
    } catch {
      return []
    }
  })
  const narration = entries.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
  const answers = entries.reduce<string[]>(
    (acc, e) => (e.type === 'attempt' || e.type === 'answer_reset' ? [...acc, ''] : e.type === 'answer' ? [...acc.slice(0, -1), `${acc.at(-1) ?? ''}${e.text}`] : acc),
    [''],
  )
  const answer = answers.findLast((a) => a !== '') ?? ''
  return answer ? `${narration}${narration ? '\n\n' : ''}${answer}` : narration
}
