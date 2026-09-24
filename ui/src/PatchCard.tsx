import { useState } from 'react'
import type { Message } from '../../server/review-store.ts'
import { api, type ChangeId } from './api.ts'
import { useAction } from './feedback.tsx'
import { defaultSummary } from './keys.ts'

const lineClass = (line: string): string =>
  line.startsWith('+') && !line.startsWith('+++') ? 'a' : line.startsWith('-') && !line.startsWith('---') ? 'd' : line.startsWith('@@') ? 'h' : ''

export interface PatchCardProps {
  id: ChangeId
  threadId: string
  index: number
  message: Message
  disabled: boolean
  archived: boolean
}

export function PatchCard({ id, threadId, index, message, disabled, archived }: PatchCardProps) {
  const act = useAction()
  const patch = message.patch!
  const [summary, setSummary] = useState(defaultSummary(message.text))
  const inputId = `summary-${threadId}-${index}`
  return (
    <div className="patch">
      <div className="ph2">
        <span className="files">{patch.files.join(' · ')}</span>
        <span className={`pill p-${patch.state}`}>{patch.state}</span>
      </div>
      <pre className="diff">
        {patch.diff.trimEnd().split('\n').map((line, i) => <div key={i} className={lineClass(line)}>{line || ' '}</div>)}
      </pre>
      {patch.error ? <div className="fail">{patch.error}</div> : null}
      {patch.state === 'proposed' && !archived ? (
        <div className="pa">
          <label htmlFor={inputId} className="hash">Commit summary</label>
          <input id={inputId} value={summary} maxLength={120} onChange={(e) => setSummary(e.target.value)} />
          <button className="btn pri" disabled={disabled || !summary.trim()} onClick={() => void act(() => api.applyPatch(id, threadId, index, summary), 'Patch committed')}>Apply &amp; commit</button>
          <button className="btn" onClick={() => void act(() => api.rejectPatch(id, threadId, index), 'Patch rejected')}>Reject</button>
          {disabled ? <span className="hash">An Apply run is active — wait for it to finish.</span> : null}
        </div>
      ) : null}
      {patch.state === 'stale' && !archived ? (
        <div className="pa">
          <button className="btn" disabled={disabled} onClick={() => void act(() => api.recheckPatch(id, threadId, index), 'Patch re-checked')}>Re-check</button>
          <span className="hash">Checks the patch again against the current files.</span>
        </div>
      ) : null}
      {patch.state === 'applied' ? <div className="pa"><span className="state ok">Applied{patch.commit ? ` · ${patch.commit}` : ''}</span></div> : null}
    </div>
  )
}
