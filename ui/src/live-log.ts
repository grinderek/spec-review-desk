export interface RunEventMessage {
  type?: string
  event?: { type?: string; text?: string }
}

// Final review Minor 1: `StructuredOutput` can be re-emitted mid-run (seen on the real CLI) or
// relaunched by a validation retry, and either one resets the answer via `answer_reset`. The live
// log must drop everything accumulated so far for the current attempt, or a re-emitted answer
// shows up twice while the persisted `logText` (server/apply-outcome.ts) stays correct.
export function reduceLiveLog(text: string, message: RunEventMessage | null): string {
  if (message?.type !== 'event') return text
  const kind = message.event?.type
  if (kind === 'answer_reset') return ''
  if (kind === 'delta' || kind === 'answer_delta') return text + (message.event?.text ?? '')
  return text
}
