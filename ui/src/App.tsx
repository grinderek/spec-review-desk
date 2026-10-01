import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, ApiError } from './api.ts'
import { ChangeScreen } from './ChangeScreen.tsx'
import { useInvalidation } from './events.ts'
import { InitiativeScreen } from './InitiativeScreen.tsx'
import { NewFeature } from './NewFeature.tsx'
import { hashOf, readHash, type Selection } from './selection.ts'
import { Sidebar } from './Sidebar.tsx'
import { ThreadPanel } from './ThreadPanel.tsx'

export type PanelTarget =
  | { kind: 'new'; anchor: 'scenario' | 'phrase' | 'change'; ref: string; title: string }
  | { kind: 'thread'; id: string }

const keyOf = (s: Selection | null): string => (s ? hashOf(s) : '')

export function App({ sessionError }: { sessionError: string | null }) {
  useInvalidation()
  const [selected, setSelected] = useState<Selection | null>(() => readHash(window.location.hash))
  const [panel, setPanel] = useState<PanelTarget | null>(null)
  useEffect(() => {
    const onHash = () => setSelected(readHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => setPanel(null), [keyOf(selected)])
  const status = useQuery({ queryKey: ['status'], queryFn: api.status })
  const changes = useQuery({ queryKey: ['changes'], queryFn: api.changes })
  const initiatives = useQuery({ queryKey: ['initiatives'], queryFn: api.initiatives })
  const unauthorized = changes.error instanceof ApiError && changes.error.status === 401
  const go = (s: Selection) => { window.location.hash = hashOf(s) }
  const change = selected?.kind === 'change' ? selected.id : null
  // Initiatives and the New feature form have no thread panel; they take its column.
  const wide = selected?.kind === 'initiative' || selected?.kind === 'new'

  return (
    <>
      {sessionError || unauthorized ? <div className="banner bad">{sessionError ?? 'Not signed in — open the URL printed in the server console.'}</div> : null}
      {status.data && !status.data.capabilities.codex ? <div className="banner warn">codex is not on PATH — questions and Apply are disabled.</div> : null}
      <div className={wide ? 'layout wide' : 'layout'}>
        <Sidebar data={changes.data} initiatives={initiatives.data?.initiatives} selected={selected} onSelect={go} />
        <main className="pane main">
          {selected?.kind === 'change' ? <ChangeScreen key={keyOf(selected)} id={selected.id} capabilities={status.data?.capabilities} setPanel={setPanel} /> : null}
          {selected?.kind === 'initiative' ? <InitiativeScreen key={keyOf(selected)} id={selected.id} /> : null}
          {selected?.kind === 'new' ? <NewFeature choices={initiatives.data} onCreated={(id) => go({ kind: 'initiative', id })} /> : null}
          {selected ? null : <p className="empty">Pick a change or an initiative on the left, or start a new feature.</p>}
        </main>
        {wide ? null : (
          <aside className="pane thread" aria-label="Thread">
            {change && panel ? (
              <ThreadPanel key={panel.kind === 'thread' ? panel.id : `new:${panel.anchor}:${panel.ref}`} id={change} target={panel} onTarget={setPanel} />
            ) : (
              <p className="empty">Select a scenario and ask a question, or open a thread.</p>
            )}
          </aside>
        )}
      </div>
    </>
  )
}
