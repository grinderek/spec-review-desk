import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Capabilities, type ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { ChangeHeader } from './ChangeHeader.tsx'
import { isActive } from './decision-view.ts'
import { DecisionsTab } from './DecisionsTab.tsx'
import { DocTab } from './DocTab.tsx'
import { PhrasesTab } from './PhrasesTab.tsx'
import { ScenariosTab } from './ScenariosTab.tsx'
import { KitchenTab, VerificationTab } from './VerificationTab.tsx'

export type TabId = 'scenarios' | 'phrases' | 'decisions' | 'proposal' | 'verification' | 'kitchen'

export function ChangeScreen({ id, capabilities, setPanel }: { id: ChangeId; capabilities: Capabilities | undefined; setPanel: (t: PanelTarget) => void }) {
  const change = useQuery({ queryKey: ['change', id.wt, id.name], queryFn: () => api.change(id) })
  const corpus = useQuery({ queryKey: ['corpus', id.wt, id.name], queryFn: () => api.corpus(id) })
  const runner = useQuery({ queryKey: ['runner', id.wt], queryFn: () => api.runner(id.wt) })
  const [tab, setTab] = useState<TabId>('scenarios')
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [focusDecision, setFocusDecision] = useState<string | null>(null)
  if (change.isLoading) return <p className="empty">Loading {id.name}…</p>
  if (change.error || !change.data) return <div className="banner bad">{change.error instanceof Error ? change.error.message : 'Change not found'}</div>
  const view = change.data
  const openDecision = (decisionId: string) => {
    setTab('decisions')
    setFocusDecision(decisionId)
  }
  const runnerState = runner.data?.state ?? null
  const tabs: [TabId, string, number | null][] = [
    ['scenarios', 'Scenarios', view.features.reduce((n, f) => n + f.scenarios.length, 0)],
    ['phrases', 'New phrases', view.phrases.length],
    ['decisions', 'Decisions', view.decisions.filter(isActive).length],
    ['proposal', 'Proposal', null],
    ['verification', 'Verification', view.review.apply_runs.length || null],
    ['kitchen', 'Kitchen', null],
  ]
  return (
    <>
      <ChangeHeader id={id} view={view} corpus={corpus.data} runner={runnerState} capabilities={capabilities} />
      <div className="tabs" role="tablist">
        {tabs.map(([key, label, count]) => (
          <button key={key} className="tab" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}{count !== null ? <span className="c">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="tabpanel">
        {tab === 'scenarios' ? <ScenariosTab id={id} view={view} corpus={corpus.data} runner={runnerState} setPanel={setPanel} focusKey={focusKey} onDecision={openDecision} /> : null}
        {tab === 'phrases' ? <PhrasesTab id={id} view={view} setPanel={setPanel} /> : null}
        {tab === 'decisions' ? (
          <DecisionsTab id={id} view={view} focusDecision={focusDecision} setPanel={setPanel} onGoto={(key) => { setTab('scenarios'); setFocusKey(key) }} />
        ) : null}
        {tab === 'proposal' ? <DocTab title="proposal.md" text={view.docs.proposal} /> : null}
        {tab === 'verification' ? <VerificationTab id={id} view={view} runner={runnerState} setPanel={setPanel} /> : null}
        {tab === 'kitchen' ? <KitchenTab view={view} /> : null}
      </div>
    </>
  )
}
