import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { api, type InitiativeId, type InitiativeView, type SandboxStatus } from './api.ts'
import { DocTab } from './DocTab.tsx'
import { PlanTab } from './PlanTab.tsx'

// Spec B §8: header + tabs Plan, Brief, Inputs, Decisions, Research, Runs.
export type InitiativeTab = 'plan' | 'brief' | 'inputs' | 'decisions' | 'research' | 'runs'
export interface TabProps { id: InitiativeId; view: InitiativeView; sandbox: SandboxStatus | undefined }
type TabEntry = [InitiativeTab, string, (view: InitiativeView) => number | null, (props: TabProps) => ReactNode]

const TABS: TabEntry[] = [
  ['plan', 'Plan', (v) => v.doc.plan.slices.length, (props) => <PlanTab {...props} />],
  ['brief', 'Brief', () => null, ({ view }) => <DocTab title="brief.md" text={view.brief} />],
]

function Header({ view, sandbox }: { view: InitiativeView; sandbox: SandboxStatus | undefined }) {
  const running = view.doc.runs.filter((r) => r.outcome === 'running').length
  const applied = Object.values(view.statuses).filter((s) => s === 'applied').length
  return (
    <div className="head">
      <div className="crumbs">{view.repo} · {view.branch ?? 'detached'} · {view.relDir}</div>
      <h1>{view.name}<span className="subtitle">{view.doc.title}</span></h1>
      <div className="gate">
        <div><div className="k">Slice plan</div><div className="v">{view.doc.plan.status}</div></div>
        <div><div className="k">Slices applied</div><div className="v">{applied} / {view.doc.plan.slices.length}</div></div>
        <div><div className="k">Open decisions</div><div className="v">{view.openDecisions} · {view.blockingDecisions} blocking</div></div>
        <div><div className="k">Runs</div><div className="v">{running ? `${running} running` : 'idle'}</div></div>
      </div>
      {sandbox && !sandbox.ready ? (
        <div className="banner warn" role="alert">The sandbox is not ready — research, planning and proposing are disabled. {sandbox.fixes.join(' · ')}</div>
      ) : null}
      {view.uncommitted ? <div className="warnings"><div>Uncommitted initiative changes (plan edits are saved without a commit; approving commits them).</div></div> : null}
    </div>
  )
}

export function InitiativeScreen({ id }: { id: InitiativeId }) {
  const initiative = useQuery({ queryKey: ['initiative', id.wt, id.name], queryFn: () => api.initiative(id) })
  const sandbox = useQuery({ queryKey: ['sandbox'], queryFn: api.sandboxStatus })
  const [tab, setTab] = useState<InitiativeTab>(TABS[0]![0])
  if (initiative.isLoading) return <p className="empty">Loading {id.name}…</p>
  if (initiative.error || !initiative.data) return <div className="banner bad">{initiative.error instanceof Error ? initiative.error.message : 'Initiative not found'}</div>
  const view = initiative.data
  const current = TABS.find(([key]) => key === tab) ?? TABS[0]!
  return (
    <>
      <Header view={view} sandbox={sandbox.data} />
      <div className="tabs" role="tablist">
        {TABS.map(([key, label, count]) => {
          const n = count(view)
          return (
            <button key={key} className="tab" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}{n !== null ? <span className="c">{n}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="tabpanel">{current[3]({ id, view, sandbox: sandbox.data })}</div>
    </>
  )
}
