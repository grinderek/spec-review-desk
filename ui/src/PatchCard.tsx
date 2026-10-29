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
  agentBusy: boolean
  archived: boolean
}

export function PatchCard({ id, threadId, index, message, disabled, agentBusy, archived }: PatchCardProps) {
  const act = useAction()
  const patch = message.patch!
  const [summary, setSummary] = useState(defaultSummary(message.text))
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try { await act(() => api.refreshPatch(id, threadId, index), 'Запрошен новый патч по текущим файлам') }
    finally { setRefreshing(false) }
  }
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
      {patch.state === 'proposed' && !patch.effect_id && !archived ? (
        <div className="pa">
          <label htmlFor={inputId} className="hash">Commit summary</label>
          <input id={inputId} value={summary} maxLength={120} onChange={(e) => setSummary(e.target.value)} />
          <button className="btn pri" disabled={disabled || !summary.trim()} onClick={() => void act(() => api.applyPatch(id, threadId, index, summary), 'Patch committed')}>Apply &amp; commit</button>
          <button className="btn" onClick={() => void act(() => api.rejectPatch(id, threadId, index), 'Patch rejected')}>Reject</button>
          {disabled ? <span className="hash">An Apply run is active - wait for it to finish.</span> : null}
        </div>
      ) : null}
      {patch.effect_id && patch.state !== 'applied' && !archived ? (
        <div className="pa">
          <span className="hash">{patch.state === 'uncertain' ? 'The Git result needs verification. No files are changed by recovery.' : 'The recorded application has no confirmed commit yet.'}</span>
          <button className="btn" disabled={disabled} onClick={() => void act(() => api.applyPatch(id, threadId, index, summary || 'Resume recorded application'), 'Patch commit verified')}>Retry recorded application</button>
        </div>
      ) : null}
      {patch.state === 'stale' && !patch.effect_id && !archived ? (
        <div className="pa">
          <button className="btn pri" disabled={disabled || agentBusy || refreshing} onClick={() => void refresh()}>{refreshing ? 'Запрашивается патч...' : agentBusy ? 'Ожидание ответа агента...' : 'Обновить патч'}</button>
          <button className="btn" disabled={disabled} onClick={() => void act(() => api.recheckPatch(id, threadId, index), 'Patch re-checked')}>Re-check</button>
          <button className="btn" disabled={disabled} onClick={() => void act(() => api.rejectPatch(id, threadId, index), 'Patch rejected')}>Reject</button>
          <span className="hash">Обновить патч - запросить новую версию у агента. Re-check - только проверить прежний diff.</span>
        </div>
      ) : null}
      {patch.state === 'applied' ? <div className="pa"><span className="state ok">Applied{patch.commit ? ` · ${patch.commit}` : ''}</span></div> : null}
    </div>
  )
}
