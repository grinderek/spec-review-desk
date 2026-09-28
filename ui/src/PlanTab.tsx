import { useState } from 'react'
import { api, type SliceEdit } from './api.ts'
import { AutoGrowTextarea } from './AutoGrowTextarea.tsx'
import { useAction } from './feedback.tsx'
import type { TabProps } from './InitiativeScreen.tsx'
import { addEdit, editsChanged, moveEdit, removeEdit, sliceCard, toEdits, toggleDependency } from './initiative-view.ts'
import { RunStream } from './RunStream.tsx'

// Spec B §4.2–§4.4, §8: plan, edit and approve the slices, then propose them one by one.
function SliceEditor({ edits, setEdits, locked, fixedOrder }: {
  edits: SliceEdit[]
  setEdits: (next: SliceEdit[]) => void
  locked: (id: string | null) => boolean
  fixedOrder: boolean
}) {
  const update = (index: number, change: Partial<SliceEdit>) => setEdits(edits.map((e, i) => (i === index ? { ...e, ...change } : e)))
  return (
    <div className="editor">
      {edits.map((e, i) => {
        const frozen = locked(e.id)
        const label = e.id ?? `new ${i + 1}`
        return (
          <div key={`${e.id ?? 'new'}-${i}`} className="slicecard edit">
            <div className="shead">
              <span className="mono">{label}</span>
              <input aria-label={`Title of slice ${i + 1}`} value={e.title} disabled={frozen} onChange={(ev) => update(i, { title: ev.target.value })} />
              {fixedOrder ? null : (
                <>
                  <button type="button" className="btn" aria-label={`Move slice ${i + 1} up`} onClick={() => setEdits(moveEdit(edits, i, -1))}>↑</button>
                  <button type="button" className="btn" aria-label={`Move slice ${i + 1} down`} onClick={() => setEdits(moveEdit(edits, i, 1))}>↓</button>
                </>
              )}
              {frozen ? null : <button type="button" className="btn bad" aria-label={`Remove slice ${i + 1}`} onClick={() => setEdits(removeEdit(edits, i))}>×</button>}
            </div>
            <AutoGrowTextarea className="scopeedit" aria-label={`Scope of slice ${i + 1}`} value={e.scope} disabled={frozen} onChange={(ev) => update(i, { scope: ev.target.value })} />
            <div className="deps">
              Depends on:
              {edits.filter((o) => o.id && o.id !== e.id).map((o) => (
                <label key={o.id}>
                  <input type="checkbox" disabled={frozen} checked={e.depends_on.includes(o.id!)} onChange={() => setEdits(toggleDependency(edits, i, o.id!))} /> {o.id}
                </label>
              ))}
            </div>
          </div>
        )
      })}
      <button type="button" className="btn" onClick={() => setEdits(addEdit(edits))}>+ Slice</button>
    </div>
  )
}

function ProposeForm({ id, sliceId, disabled }: { id: TabProps['id']; sliceId: string; disabled: boolean }) {
  const act = useAction()
  const [notes, setNotes] = useState('')
  const [change, setChange] = useState('')
  return (
    <form className="panelform" onSubmit={(e) => { e.preventDefault(); void act(() => api.proposeSlice(id, sliceId, { notes, ...(change.trim() ? { change: change.trim() } : {}) }), `Proposing ${sliceId}…`) }}>
      <textarea aria-label={`Notes for ${sliceId}`} placeholder="Notes for the author (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <input aria-label={`Change name for ${sliceId}`} placeholder="change name (default: add-<initiative>-<slice title>)" value={change} onChange={(e) => setChange(e.target.value)} />
      <div className="row"><button type="submit" className="btn pri" disabled={disabled}>Propose {sliceId}</button></div>
    </form>
  )
}

function ApprovedPlan({ id, view, sandbox }: TabProps) {
  const act = useAction()
  const ready = sandbox?.ready ?? false
  return (
    <>
      {view.doc.plan.slices.map((s) => {
        const status = view.statuses[s.id] ?? 'planned'
        const card = sliceCard(view, s.id)
        return (
          <div key={s.id} className={`slicecard st-${status}`} data-slice={s.id}>
            <div className="shead">
              <span className="mono">{s.id}</span>
              <b>{s.title}</b>
              <span className={`pill p-${status}`}>{status}</span>
              {s.change ? <a className="linkbtn" href={`#/${view.worktreeId}/${encodeURIComponent(s.change)}`}>{s.change}</a> : null}
            </div>
            <div className="scope">{s.scope}</div>
            {s.depends_on.length ? <div className="hash">depends on {s.depends_on.join(', ')}</div> : null}
            {card.kind === 'ready' ? <ProposeForm id={id} sliceId={s.id} disabled={!ready} /> : null}
            {card.kind === 'waiting' ? <div className="hash">{card.text}</div> : null}
            {card.kind === 'proposing' && card.runId ? (
              <>
                {card.waiting
                  ? <div className="hash">The author is waiting for your decisions: decide them in the inbox, then Resume it under Runs — or Stop to abandon it.</div>
                  : <RunStream id={id} runId={card.runId} />}
                <div className="row"><button className="btn bad" onClick={() => void act(() => api.stopRun(id, card.runId!), 'Stopping…')}>Stop</button></div>
              </>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

export function PlanTab({ id, view, sandbox }: TabProps) {
  const act = useAction()
  const plan = view.doc.plan
  const [edits, setEdits] = useState<SliceEdit[] | null>(null)
  // A planner start assembles its room before it answers: never a second click meanwhile.
  const [starting, setStarting] = useState(false)
  const current = edits ?? toEdits(plan)
  const dirty = edits !== null && editsChanged(plan, edits)
  const ready = sandbox?.ready ?? false
  const planner = view.doc.runs.find((r) => r.kind === 'planner' && r.outcome === 'running')
  const save = () => act(async () => { await api.savePlan(id, current); setEdits(null) }, 'Plan saved (not committed)')
  const replan = () => {
    if (dirty && !window.confirm('Re-plan replaces the draft; your unsaved edits are lost. Continue?')) return
    setEdits(null)
    setStarting(true)
    void act(() => api.runPlanner(id), 'Planner started').finally(() => setStarting(false))
  }
  if (planner) {
    return (
      <>
        <p>The planner is proposing slices…</p>
        <RunStream id={id} runId={planner.id} />
        <div className="row"><button className="btn bad" onClick={() => void act(() => api.stopRun(id, planner.id), 'Stopping…')}>Stop</button></div>
      </>
    )
  }
  if (plan.status === 'none' && edits === null) {
    return (
      <div className="toolbar">
        <button className="btn pri" disabled={!ready || starting} onClick={replan}>{starting ? 'Starting the planner…' : 'Plan slices'}</button>
        <button className="btn" onClick={() => setEdits([])}>Write the plan by hand</button>
      </div>
    )
  }
  if (plan.status === 'approved' && edits === null) {
    return (
      <>
        <div className="toolbar">
          <span>Approved {plan.approved_at?.slice(0, 10)} · {plan.slices.length} slices</span>
          <button className="btn" onClick={() => setEdits(toEdits(plan))}>Edit plan</button>
        </div>
        <ApprovedPlan id={id} view={view} sandbox={sandbox} />
      </>
    )
  }
  const approved = plan.status === 'approved'
  return (
    <>
      <div className="toolbar">
        <span>{approved ? 'Editing the approved plan: add slices at the end, edit or remove planned ones.' : 'Draft plan'}</span>
        <button className="btn" disabled={!dirty} onClick={() => void save()}>{approved ? 'Save plan' : 'Save draft'}</button>
        {approved ? <button className="btn" onClick={() => setEdits(null)}>Cancel</button> : null}
        {approved ? null : <button className="btn" disabled={!ready || starting} onClick={replan}>Re-plan</button>}
        {approved ? null : (
          <button className="btn pri" disabled={dirty || view.blockingDecisions > 0 || current.length === 0} onClick={() => void act(() => api.approvePlan(id), 'Slice plan approved')}>
            {view.blockingDecisions ? `Approve plan (${view.blockingDecisions} blocking decision${view.blockingDecisions > 1 ? 's' : ''})` : 'Approve plan'}
          </button>
        )}
      </div>
      <SliceEditor edits={current} setEdits={setEdits} fixedOrder={approved} locked={(sid) => approved && sid !== null && (view.statuses[sid] ?? 'planned') !== 'planned'} />
    </>
  )
}
