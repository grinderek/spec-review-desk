import { useState } from 'react'
import { api, type InitiativeView, initiativeDecisions, type RunRecord } from './api.ts'
import { DecisionCard } from './DecisionCard.tsx'
import { history, inbox, type InboxFilter } from './decision-view.ts'
import { useAction } from './feedback.tsx'
import type { TabProps } from './InitiativeScreen.tsx'
import { DraftActions, InputViewer } from './InputViewer.tsx'
import { canResume, runTitle } from './initiative-view.ts'
import { NewDecisionForm } from './NewDecisionForm.tsx'
import { RunStream } from './RunStream.tsx'

// Spec B §8: Inputs, Decisions (A's inbox for the initiative), Research and Runs.
function sourceText(input: InitiativeView['inputs'][number]): string {
  if (input.source.kind === 'repo') return `from ${input.source.path} @ ${input.source.commit}`
  if (input.source.kind === 'research') return `research run ${input.source.run}${input.source.domains.length ? ` · read ${input.source.domains.join(', ')}` : ' · search only'}`
  return 'uploaded'
}

// The input open in the viewer (by file name): gone from the view — discarded — closes it.
function useViewer(view: InitiativeView) {
  const [open, setOpen] = useState<string | null>(null)
  return { shown: view.inputs.find((i) => i.file === open) ?? null, open: setOpen, close: () => setOpen(null) }
}

export function InputsTab({ id, view }: TabProps) {
  const act = useAction()
  const viewer = useViewer(view)
  const [files, setFiles] = useState<File[]>([])
  const [from, setFrom] = useState('')
  const upload = () => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return act(async () => { await api.uploadInputs(id, form); setFiles([]) }, 'Inputs uploaded and committed')
  }
  return (
    <>
      {viewer.shown ? <InputViewer id={id} input={viewer.shown} onClose={viewer.close} /> : null}
      {view.inputs.length === 0 ? <p className="empty">No inputs yet.</p> : (
        <div className="tablewrap">
          <table className="list">
            <thead><tr><th>File</th><th>Size</th><th>Provenance</th><th /></tr></thead>
            <tbody>
              {view.inputs.map((i) => (
                <tr key={i.file} data-input={i.file}>
                  <td className="mono">
                    <button className="linkbtn mono" onClick={() => viewer.open(i.file)}>{i.file}</button>{' '}
                    {i.draft ? <span className="pill p-draft">draft</span> : null}{i.present ? null : <span className="pill p-failed">missing</span>}
                  </td>
                  <td>{i.bytes} B</td>
                  <td>{sourceText(i)}</td>
                  <td>{i.draft ? <DraftActions id={id} file={i.file} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="panelform" onSubmit={(e) => { e.preventDefault(); void upload() }}>
        <label htmlFor="upload-inputs">Upload inputs</label>
        <input id="upload-inputs" type="file" multiple accept=".pdf,.md,.txt,.yaml,.yml,.json,.png,.jpg,.jpeg" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        <div className="row"><button type="submit" className="btn" disabled={files.length === 0}>Upload</button></div>
      </form>
      <form className="panelform" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.addFromRepo(id, from.trim()); setFrom('') }, 'Input added from the repo') }}>
        <label htmlFor="add-from-repo">Add from repo (path relative to the hub)</label>
        <input id="add-from-repo" value={from} placeholder="api/doc/health_score_client_contract.md" onChange={(e) => setFrom(e.target.value)} />
        <div className="row"><button type="submit" className="btn" disabled={!from.trim()}>Add</button></div>
      </form>
    </>
  )
}

export function InitiativeDecisionsTab({ id, view }: TabProps) {
  const [filter, setFilter] = useState<InboxFilter>('open')
  const [adding, setAdding] = useState(false)
  const client = initiativeDecisions(id)
  const items = inbox(view.decisions, filter)
  const timeline = history([], view.decisionLog)
  return (
    <>
      <div className="toolbar">
        <h4 className="inline">Inbox</h4>
        <button className="chip" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open</button>
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
        <button className="btn" disabled={adding} onClick={() => setAdding(true)}>+ Open decision</button>
      </div>
      {adding ? <NewDecisionForm client={client} scenarioKeys={[]} onClose={() => setAdding(false)} /> : null}
      {items.length === 0 ? <p className="empty">{filter === 'open' ? 'No open decisions.' : 'No decisions yet.'}</p> : null}
      {items.map((d) => <DecisionCard key={d.id} client={client} decision={d} archived={false} scenarioKeys={[]} />)}
      <h4>History</h4>
      {timeline.length === 0 ? <p className="empty">Nothing recorded in decisions.md yet.</p> : (
        <ol className="dlog">
          {timeline.map((item, i) => (
            <li key={i}>
              <div className="hash">{item.date} · decisions.md</div>
              <div><b>{item.title}</b></div>
              <div>{item.text}</div>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

export function ResearchTab({ id, view, sandbox }: TabProps) {
  const act = useAction()
  const [topic, setTopic] = useState('')
  const [questions, setQuestions] = useState('')
  const [domains, setDomains] = useState<string | null>(null)
  const viewer = useViewer(view)
  const research = view.doc.runs.filter((r) => r.kind === 'research')
  const drafts = view.inputs.filter((i) => i.draft)
  const domainText = domains ?? view.doc.research.domains.join('\n')
  return (
    <>
      <form className="panelform" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.startResearch(id, { topic: topic.trim(), questions: questions.trim() }); setTopic(''); setQuestions('') }, 'Research started') }}>
        <h4>Research…</h4>
        <input aria-label="Research topic" placeholder="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <textarea aria-label="Research questions" placeholder="The questions to answer" value={questions} onChange={(e) => setQuestions(e.target.value)} />
        <div className="row"><button type="submit" className="btn pri" disabled={!sandbox?.ready || !topic.trim() || !questions.trim()}>Research</button></div>
      </form>
      <h4>Topics</h4>
      {research.length === 0 ? <p className="empty">No research yet.</p> : research.map((r) => (
        <div key={r.id} className="hash">{r.topic} · <span className={`pill p-${r.outcome}`}>{r.outcome}</span> · {r.phase ?? 'search'} phase</div>
      ))}
      <h4>Drafts</h4>
      {viewer.shown ? <InputViewer id={id} input={viewer.shown} onClose={viewer.close} /> : null}
      {drafts.length === 0 ? <p className="empty">No research draft waiting.</p> : drafts.map((d) => (
        <div key={d.file} className="row" style={{ justifyContent: 'flex-start' }}>
          <button className="linkbtn mono" onClick={() => viewer.open(d.file)}>{d.file}</button>
          <DraftActions id={id} file={d.file} />
        </div>
      ))}
      <form className="panelform" onSubmit={(e) => {
        e.preventDefault()
        void act(async () => { await api.setDomains(id, domainText.split('\n').map((l) => l.trim()).filter(Boolean)); setDomains(null) }, 'Domain allowlist saved and committed')
      }}>
        <h4>WebFetch domain allowlist</h4>
        <textarea aria-label="Allowed domains" placeholder="one hostname per line" value={domainText} onChange={(e) => setDomains(e.target.value)} />
        <div className="row"><button type="submit" className="btn" disabled={domains === null}>Save domains</button></div>
      </form>
    </>
  )
}

function RunCard({ id, view, run }: { id: TabProps['id']; view: InitiativeView; run: RunRecord }) {
  const act = useAction()
  const [log, setLog] = useState<string | null>(null)
  // Disabled while its request is in flight: a double click never sends two resumes (final review I1).
  const [resuming, setResuming] = useState(false)
  const resumable = canResume(view, run)
  const resume = (): void => {
    setResuming(true)
    void act(() => api.resumeRun(id, run.id), 'Resumed').finally(() => setResuming(false))
  }
  return (
    <div className="slicecard" data-run={run.id}>
      <div className="shead">
        <b>{runTitle(run)}</b>
        <span className={`pill p-${run.outcome}`}>{run.outcome}</span>
        <span className="hash">{run.id} · {run.started_at}{run.ended_at ? ` → ${run.ended_at}` : ''}</span>
      </div>
      {run.notes ? <div className="scope">{run.notes}</div> : null}
      {run.problems?.length ? <div className="fail">{run.problems.map((p, i) => <div key={i}>{p}</div>)}</div> : null}
      {run.outcome === 'running' ? <RunStream id={id} runId={run.id} /> : null}
      <div className="row">
        {run.outcome === 'running' || run.outcome === 'needs_owner' ? <button className="btn bad" onClick={() => void act(() => api.stopRun(id, run.id), 'Stopping…')}>Stop</button> : null}
        {run.outcome === 'needs_owner' ? (
          <button className="btn pri" disabled={!resumable || resuming} title={resumable ? '' : "Decide or dismiss the run's blocking decisions first"} onClick={resume}>Resume</button>
        ) : null}
        <button className="btn" onClick={() => void act(async () => setLog((await api.initiativeRunLog(id, run.id)).text))}>Show log</button>
      </div>
      {log !== null ? <pre className="doc">{log || '(empty)'}</pre> : null}
    </div>
  )
}

export function RunsTab({ id, view }: TabProps) {
  const runs = [...view.doc.runs].reverse()
  return runs.length === 0 ? <p className="empty">No runs yet.</p> : <>{runs.map((r) => <RunCard key={r.id} id={id} view={view} run={r} />)}</>
}
