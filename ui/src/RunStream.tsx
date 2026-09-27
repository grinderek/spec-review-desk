import { useState } from 'react'
import { api, type InitiativeId } from './api.ts'
import { useEventStream } from './events.ts'
import { reduceLiveLog, type RunEventMessage } from './live-log.ts'

// The live answer of a sandboxed run: narration deltas and the streamed StructuredOutput answer.
export function RunStream({ id, runId }: { id: InitiativeId; runId: string }) {
  const [text, setText] = useState('')
  useEventStream(api.initiativeRunEventsUrl(id, runId), (message) => {
    setText((current) => reduceLiveLog(current, message.data as RunEventMessage | null))
  })
  return (
    <div className="stream">
      <div className="hash">sandbox: read-only room · internal network · egress only through the run's proxy</div>
      <pre className="doc" aria-live="polite">{text || 'Waiting for the agent…'}</pre>
    </div>
  )
}
