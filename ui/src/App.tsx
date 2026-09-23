import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, ApiError, type ChangeId } from './api.ts'
import { ChangeScreen } from './ChangeScreen.tsx'
import { useInvalidation } from './events.ts'
import { Sidebar } from './Sidebar.tsx'

export type PanelTarget =
  | { kind: 'new'; anchor: 'scenario' | 'phrase' | 'change'; ref: string; title: string }
  | { kind: 'thread'; id: string }

function readHash(): ChangeId | null {
  const [wt, ...rest] = window.location.hash.replace(/^#\/?/, '').split('/')
  return wt && rest.length ? { wt, name: decodeURIComponent(rest.join('/')) } : null
}

export function App({ sessionError }: { sessionError: string | null }) {
  useInvalidation()
  const [selected, setSelected] = useState<ChangeId | null>(readHash)
  const [panel, setPanel] = useState<PanelTarget | null>(null)
  useEffect(() => {
    const onHash = () => setSelected(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => setPanel(null), [selected?.wt, selected?.name])
  const status = useQuery({ queryKey: ['status'], queryFn: api.status })
  const changes = useQuery({ queryKey: ['changes'], queryFn: api.changes })
  const unauthorized = changes.error instanceof ApiError && changes.error.status === 401

  return (
    <>
      {sessionError || unauthorized ? <div className="banner bad">{sessionError ?? 'Not signed in — open the URL printed in the server console.'}</div> : null}
      {status.data && !status.data.capabilities.claude ? <div className="banner warn">claude is not on PATH — questions and Apply are disabled.</div> : null}
      <div className="layout">
        <Sidebar data={changes.data} selected={selected} onSelect={(id) => { window.location.hash = `#/${id.wt}/${encodeURIComponent(id.name)}` }} />
        <main className="pane main">
          {selected ? <ChangeScreen key={`${selected.wt}/${selected.name}`} id={selected} capabilities={status.data?.capabilities} setPanel={setPanel} /> : <p className="empty">Pick a change on the left.</p>}
        </main>
        <aside className="pane thread" aria-label="Thread">
          <p className="empty">{panel ? 'Thread' : 'Select a scenario and ask a question, or open a thread.'}</p>
        </aside>
      </div>
    </>
  )
}
