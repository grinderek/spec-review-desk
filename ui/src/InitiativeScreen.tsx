import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { api, type InitiativeId, type InitiativeView, type SandboxStatus } from './api.ts'
import { BriefTab } from './BriefTab.tsx'
import { InitiativeDecisionsTab, InputsTab, ResearchTab, RunsTab } from './InitiativeTabs.tsx'
import { PlanTab } from './PlanTab.tsx'
import { useAction } from './feedback.tsx'

// Spec B §8: header + tabs Plan, Brief, Inputs, Decisions, Research, Runs.
export type InitiativeTab = 'plan' | 'brief' | 'inputs' | 'decisions' | 'research' | 'runs' | 'implementation'
export interface TabProps { id: InitiativeId; view: InitiativeView; sandbox: SandboxStatus | undefined }
type TabEntry = [InitiativeTab, string, (view: InitiativeView) => number | null, (props: TabProps) => ReactNode]

const TABS: TabEntry[] = [
  ['plan', 'Plan', (v) => v.doc.plan.slices.length, (props) => <PlanTab {...props} />],
  ['brief', 'Brief', () => null, (props) => <BriefTab {...props} />],
  ['inputs', 'Inputs', (v) => v.inputs.length, (props) => <InputsTab {...props} />],
  ['decisions', 'Decisions', (v) => v.openDecisions, (props) => <InitiativeDecisionsTab {...props} />],
  ['research', 'Research', (v) => v.doc.runs.filter((r) => r.kind === 'research').length, (props) => <ResearchTab {...props} />],
  ['runs', 'Runs', (v) => v.doc.runs.length, (props) => <RunsTab {...props} />],
]

function Header({ id,view, sandbox }: { id:InitiativeId;view: InitiativeView; sandbox: SandboxStatus | undefined }) {
  const act=useAction()
  const pending=view.doc.git_effects.filter(effect=>effect.status!=='completed')
  const [retrying,setRetrying]=useState(false)
  const running = view.doc.runs.filter((r) => r.outcome === 'running').length
  const applied = Object.values(view.statuses).filter((s) => s === 'applied').length
  return (
    <div className="head">
      <div className="crumbs">{view.repo} · {view.branch ?? 'detached'} · {view.relDir}</div>
      <h1>{view.name}<span className="subtitle">{view.doc.title}</span></h1>
      <div className="gate">
        <div><div className="k">Slice plan</div><div className="v">{view.doc.plan.status}{pending.length?' - commit pending':''}</div></div>
        <div><div className="k">Slices applied</div><div className="v">{applied} / {view.doc.plan.slices.length}</div></div>
        <div><div className="k">Open decisions</div><div className="v">{view.openDecisions} · {view.blockingDecisions} blocking</div></div>
        <div><div className="k">Runs</div><div className="v">{running ? `${running} running` : 'idle'}</div></div>
      </div>
      {pending.map(effect=><div key={effect.plan.effectId} className="banner warn" role="alert">
        The {effect.operation} changes are saved, but their Git commit is not confirmed. {effect.reason??''}
        <button className="btn" disabled={retrying} onClick={()=>{setRetrying(true);void act(()=>api.retryInitiativeCommit(id,effect.plan.effectId),'Changes committed').finally(()=>setRetrying(false))}}>Retry commit</button>
      </div>)}
      {sandbox && !sandbox.ready ? (
        <div className="banner warn" role="alert">The sandbox is not ready — research, planning and proposing are disabled. {sandbox.fixes.join(' · ')}</div>
      ) : null}
      {view.uncommitted ? <div className="warnings"><div>Uncommitted initiative changes (plan edits are saved without a commit; approving commits them).</div></div> : null}
    </div>
  )
}

function ImplementationSources({ id }: TabProps) {
  const sources = useQuery({ queryKey: ['implementation', id.wt, id.name], queryFn: () => api.implementation(id) })
  const [filter, setFilter] = useState('')
  if (sources.error) return <p className="banner bad">{sources.error.message}</p>
  if (!sources.data) return <p>Загружаем снимок реализации...</p>
  return <><p>Сохраненные версии исходников для исследования. Ссылки открывают файл с номерами строк.</p>
    <input aria-label="Найти исходный файл" placeholder="Путь или имя файла" value={filter} onChange={e => setFilter(e.target.value)} />
    {sources.data.sources.map(source => <details className="contract-details" key={source.repo} open={!!filter || undefined}><summary>{source.title}: {source.files.length} файлов · {source.head.slice(0, 12)}</summary>
      <p>Репозиторий: {source.repo}. Исключено из снимка: {source.excluded} файлов (формат, размер или конфиденциальные данные).</p>
      <ul>{source.files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase())).map(file => <li key={file.path}><a href={file.url} target="_blank" rel="noopener noreferrer">{file.path}</a></li>)}</ul>
    </details>)}
  </>
}

export function InitiativeScreen({ id }: { id: InitiativeId }) {
  const initiative = useQuery({ queryKey: ['initiative', id.wt, id.name], queryFn: () => api.initiative(id) })
  const sandbox = useQuery({ queryKey: ['sandbox'], queryFn: api.sandboxStatus })
  const [tab, setTab] = useState<InitiativeTab>(TABS[0]![0])
  if (initiative.isLoading) return <p className="empty">Loading {id.name}…</p>
  if (initiative.error || !initiative.data) return <div className="banner bad">{initiative.error instanceof Error ? initiative.error.message : 'Initiative not found'}</div>
  const view = initiative.data
  const process = view.doc.existingProcess
  const tabs: TabEntry[] = process ? [...TABS.filter(([key]) => key !== 'research').map((entry): TabEntry => entry[0] === 'plan' ? ['plan', 'Исследование и правила', entry[2], entry[3]] : entry), ['implementation', 'Исходники', () => null, props => <ImplementationSources {...props} />]] : TABS
  const current = tabs.find(([key]) => key === tab) ?? tabs[0]!
  return (
    <>
      <Header id={id} view={view} sandbox={sandbox.data} />
      {process ? <section className="process-context"><h2>{process.process}</h2><p>Продукт: {process.product}. {process.boundary}</p><p>Исследовать код → согласовать границы → подготовить правила → согласовать карточки.</p><p>Найденное в коде поведение остается предложением до вашего согласования. Исполнение новых правил требует подключенного адаптера.</p></section> : null}
      <div className="tabs" role="tablist">
        {tabs.map(([key, label, count]) => {
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
