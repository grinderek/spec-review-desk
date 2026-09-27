import { useEffect, useState } from 'react'
import type { ChangeView } from '../../server/change-view.ts'
import type { ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { DecisionCard } from './DecisionCard.tsx'
import { history, inbox, type InboxFilter } from './decision-view.ts'
import { NewDecisionForm } from './NewDecisionForm.tsx'

export interface DecisionsTabProps {
  id: ChangeId
  view: ChangeView
  onGoto: (key: string) => void
  focusDecision: string | null
  setPanel: (target: PanelTarget) => void
}

export function DecisionsTab({ id, view, onGoto, focusDecision, setPanel }: DecisionsTabProps) {
  const [filter, setFilter] = useState<InboxFilter>('open')
  const [adding, setAdding] = useState(false)
  const items = inbox(view.decisions, filter)
  const timeline = history(view.features, view.decisionLog)
  const keys = view.features.flatMap((f) => f.scenarios.map((s) => s.key))
  useEffect(() => {
    if (!focusDecision) return
    setFilter('all')
    window.requestAnimationFrame(() =>
      document.querySelector(`.tabpanel [data-decision="${focusDecision}"]`)?.scrollIntoView({ block: 'center' }))
  }, [focusDecision])
  return (
    <>
      <div className="toolbar">
        <h4 className="inline">Inbox</h4>
        <button className="chip" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open</button>
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
        {view.archived ? null : <button className="btn" disabled={adding} onClick={() => setAdding(true)}>+ Open decision</button>}
      </div>
      {adding ? <NewDecisionForm id={id} view={view} onClose={() => setAdding(false)} /> : null}
      {items.length === 0 ? <p className="empty">{filter === 'open' ? 'No open decisions.' : 'No decisions yet.'}</p> : null}
      {items.map((d) => (
        <DecisionCard
          key={d.id}
          id={id}
          decision={d}
          archived={view.archived}
          scenarioKeys={keys}
          onThread={(threadId) => setPanel({ kind: 'thread', id: threadId })}
        />
      ))}
      <h4>History</h4>
      {timeline.length === 0 ? (
        <p className="empty">Nothing recorded yet — neither "# Owner decision" comments nor decisions.md entries.</p>
      ) : (
        <ol className="dlog">
          {timeline.map((item, i) => (
            <li key={`${item.kind}:${i}`}>
              <div className="hash">{item.date} · {item.kind === 'gherkin' ? '# Owner decision' : 'decisions.md'}{item.commit ? ` · ${item.commit}` : ''}</div>
              <div><b>{item.title}</b></div>
              <div>{item.text}</div>
              {item.key ? <button className="linkbtn" onClick={() => onGoto(item.key ?? '')}>→ scenario</button> : null}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
