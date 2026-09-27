import { useId, useState } from 'react'
import type { DecisionView } from '../../server/change-view.ts'
import type { DecisionClient } from './api.ts'
import { isActive, outcomeLine, scenarioTitle, scopeLabel, sourceLabel } from './decision-view.ts'
import { useAction } from './feedback.tsx'

export interface DecisionCardProps {
  client: DecisionClient
  decision: DecisionView
  archived: boolean
  scenarioKeys: readonly string[]
  onThread?: (threadId: string) => void
}

export function DecisionCard({ client, decision: d, archived, scenarioKeys, onThread }: DecisionCardProps) {
  const act = useAction()
  const uid = useId()
  const [option, setOption] = useState<string | null>(d.recommended)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState<string | null>(null)
  const [to, setTo] = useState(scenarioKeys[0] ?? '')
  const needsNote = d.options.length === 0
  const outcome = outcomeLine(d)
  const canDecide = d.status === 'open' && !d.orphaned && !archived
  const decide = () =>
    act(async () => {
      const result = await client.decide(d.id, { option, note: note.trim() })
      if (result.status === 'decided') onThread?.(result.threadId)
    }, d.scope.kind === 'change' ? 'Decision recorded in decisions.md' : 'Decision sent to the agent for its patch')
  const dismiss = (text: string) =>
    act(() => client.dismiss(d.id, text), 'Decision dismissed').then((ok) => {
      if (ok) setReason(null)
    })
  return (
    <div className={`dcard d-${d.status}`} data-decision={d.id}>
      <div className="dhead">
        <span className={`pill p-d-${d.orphaned ? 'orphaned' : d.status}`}>{d.orphaned ? 'orphaned' : d.status}</span>
        {d.blocking ? <span className="pill p-block">blocking</span> : null}
        <b>{d.question}</b>
      </div>
      <div className="hash">{scopeLabel(d)} · {sourceLabel(d)} · {d.id}</div>
      {canDecide ? (
        <form className="dform" onSubmit={(e) => { e.preventDefault(); void decide() }}>
          {d.options.length ? (
            <fieldset className="dopts">
              <legend className="hash">Options</legend>
              {d.options.map((o) => (
                <label key={o.id} className="dopt">
                  <input type="radio" name={`${uid}-option`} value={o.id} checked={option === o.id} onChange={() => setOption(o.id)} />
                  <span>
                    <b>{o.label}</b>
                    {d.recommended === o.id ? <span className="star" title="The agent's recommendation"> ★</span> : null}
                    <span className="cons">{o.consequence}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <label htmlFor={`${uid}-note`} className="hash">{needsNote ? 'Your decision' : 'Note (optional)'}</label>
          <textarea id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button type="button" className="btn" onClick={() => setReason('')}>Dismiss…</button>
            <button type="submit" className="btn pri" disabled={needsNote ? !note.trim() : !option}>Decide</button>
          </div>
        </form>
      ) : null}
      {outcome ? <div className="doutcome">{outcome}</div> : null}
      {d.orphaned && isActive(d) && !archived && client.reattach ? (
        <div className="row">
          <span className="hash">The scenario of this decision no longer exists.</span>
          <select aria-label="Re-attach to" value={to} onChange={(e) => setTo(e.target.value)}>
            {scenarioKeys.map((k) => <option key={k} value={k}>{scenarioTitle(k)}</option>)}
          </select>
          <button className="btn" disabled={!to} onClick={() => void act(() => client.reattach!(d.id, to), 'Decision re-attached')}>Re-attach</button>
        </div>
      ) : null}
      {!canDecide && isActive(d) && !archived && reason === null ? (
        <div className="row"><button className="btn" onClick={() => setReason('')}>Dismiss…</button></div>
      ) : null}
      {reason !== null ? (
        <form className="reason" onSubmit={(e) => { e.preventDefault(); void dismiss(reason) }}>
          <label htmlFor={`${uid}-reason`}>Why dismiss it?</label>
          <textarea id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} required />
          <div className="row">
            <button className="btn" type="button" onClick={() => setReason(null)}>Cancel</button>
            <button className="btn bad" type="submit" disabled={!reason.trim()}>Dismiss</button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
