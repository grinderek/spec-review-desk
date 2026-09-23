import { useState } from 'react'
import type { ScenarioWithStatus } from '../../server/change-view.ts'
import type { CorpusState } from '../../server/corpus.ts'
import type { Effective, Thread } from '../../server/review-store.ts'
import type { ScenarioRun } from '../../server/run-messages.ts'
import { api, type ChangeId } from './api.ts'
import { type DiffLine, lineDiff } from './diff.ts'
import { useAction } from './feedback.tsx'
import { cssId } from './keys.ts'
import { DiffView, StepLines } from './StepLines.tsx'

export function StatusPill({ effective }: { effective: Effective }) {
  const label = effective.status === 'changes_requested' ? 'changes requested' : effective.changedSinceApproval ? 'pending · changed' : effective.status
  return <span className={`pill p-${effective.status}`}>{label}</span>
}

function RunPill({ run, corpus }: { run: ScenarioRun | undefined; corpus: CorpusState | undefined }) {
  if (corpus === 'not_in_corpus') return <span className="pill">not in corpus</span>
  if (corpus === 'differs') return <span className="pill r-failed">corpus differs — re-apply</span>
  if (!run) return <span className="pill">no run yet</span>
  return <span className={`pill r-${run.status}`}>● {run.status}</span>
}

export interface ScenarioCardProps {
  id: ChangeId
  scenario: ScenarioWithStatus
  run: ScenarioRun | undefined
  corpus: CorpusState | undefined
  thread: Thread | undefined
  open: boolean
  selected: boolean
  readOnly: boolean
  onToggle: () => void
  onAsk: () => void
}

export function ScenarioCard({ id, scenario: s, run, corpus, thread, open, selected, readOnly, onToggle, onAsk }: ScenarioCardProps) {
  const act = useAction()
  const [diff, setDiff] = useState<DiffLine[] | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const status = s.effective.status
  const dom = cssId(s.key)
  const showDiff = async () => {
    const d = await api.scenarioDiff(id, s.key)
    setDiff(lineDiff(d.before ?? '', d.after))
  }
  return (
    <article className={`scn ${status}${selected ? ' sel' : ''}`} id={`scn-${dom}`}>
      <div className="shead">
        <button className="stoggle" aria-expanded={open} onClick={onToggle}>
          <span className="kwt">{s.kind}:</span>
          <span className="t">{s.title}</span>
        </button>
        {s.decisions.length ? <span className="pill p-dec">{s.decisions.length} decision{s.decisions.length > 1 ? 's' : ''}</span> : null}
        {thread ? <span className="pill p-thread">thread · {thread.status}</span> : null}
        <RunPill run={run} corpus={corpus} />
        <StatusPill effective={s.effective} />
      </div>
      {open ? (
        <div className="sbody">
          {s.decisions.map((d) => (
            <div className="decision" key={d.line}>
              <b>Owner decision {d.date}{d.tag ? ` (${d.tag})` : ''}{d.commit ? ` · ${d.commit}` : ''}</b>
              {d.text}
            </div>
          ))}
          {s.notes.map((note, i) => <div className="note" key={i}>{note}</div>)}
          <div className="code">
            <StepLines steps={s.steps} />
            {s.examples.map((examples, i) => (
              <div key={i}>
                <div className="step"><span className="kw">Examples:</span><span>{examples.name}</span></div>
                <table className="dt">
                  <thead>
                    <tr>{run?.rows ? <th /> : null}{examples.header.map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {examples.rows.map((row, r) => (
                      <tr key={r}>
                        {run?.rows ? <td><span className={`dot ${run.rows[r] === 'passed' ? 'ok' : run.rows[r] === 'failed' ? 'bad' : 'warn'}`} title={run.rows[r]} /></td> : null}
                        {row.map((cell, c) => <td key={c}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          {run?.failure ? <pre className="fail">{`${run.failure.step}\n${run.failure.message}`}</pre> : null}
          {s.effective.changedSinceApproval ? (
            <div className="changed">
              Changed since approval.{' '}
              <button className="linkbtn" onClick={() => void showDiff()}>Show changes</button>
            </div>
          ) : null}
          {diff ? <DiffView lines={diff} /> : null}
          {reason !== null ? (
            <form
              className="reason"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => api.requestChanges(id, s.key, reason), 'Changes requested — the agent is answering').then((ok) => ok && setReason(null))
              }}
            >
              <label htmlFor={`reason-${dom}`}>What should change?</label>
              <textarea id={`reason-${dom}`} value={reason} onChange={(e) => setReason(e.target.value)} required />
              <div className="row">
                <button className="btn" type="button" onClick={() => setReason(null)}>Cancel</button>
                <button className="btn bad" type="submit">Send request</button>
              </div>
            </form>
          ) : null}
          {readOnly ? null : (
            <div className="sact">
              {status !== 'approved' ? (
                <button className="btn ok" onClick={() => void act(() => api.approveScenario(id, s.key), 'Scenario approved')}>Approve</button>
              ) : (
                <button className="btn" onClick={() => void act(() => api.revokeScenario(id, s.key), 'Approval revoked')}>Revoke approval</button>
              )}
              <button className="btn bad" onClick={() => setReason('')}>Request changes</button>
              <button className="btn pri" onClick={onAsk}>{thread ? 'Open thread' : 'Ask the agent'}</button>
              <span className="hash">{s.file}:{s.line}</span>
            </div>
          )}
        </div>
      ) : null}
    </article>
  )
}
