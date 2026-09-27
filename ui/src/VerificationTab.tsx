import { useState } from 'react'
import type { ChangeView } from '../../server/change-view.ts'
import type { RunnerState } from '../../server/runner.ts'
import { api, type ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { DocTab } from './DocTab.tsx'
import { useEventStream } from './events.ts'
import { useAction } from './feedback.tsx'
import { reduceLiveLog, type RunEventMessage } from './live-log.ts'

function LiveLog({ id, runId }: { id: ChangeId; runId: string }) {
  const [text, setText] = useState('')
  useEventStream(api.runEventsUrl(id, runId), (message) => {
    setText((current) => reduceLiveLog(current, message.data as RunEventMessage | null))
  })
  return <pre className="doc">{text || 'Waiting for the agent…'}</pre>
}

export function VerificationTab({ id, view, runner, setPanel }: { id: ChangeId; view: ChangeView; runner: RunnerState | null; setPanel: (t: PanelTarget) => void }) {
  const act = useAction()
  const [logs, setLogs] = useState<Record<string, string>>({})
  const failing = Object.entries(runner?.result?.scenarios ?? {}).filter(([, r]) => r.status !== 'passed')
  return (
    <>
      <h4>Apply runs</h4>
      {view.review.apply_runs.length === 0 ? <p className="empty">No Apply run yet.</p> : null}
      {[...view.review.apply_runs].reverse().map((run) => {
        const thread = view.review.threads.find((t) => t.anchor === 'apply' && t.ref === run.id)
        return (
          <div key={run.id} className="scn">
            <div className="shead">
              <span className="mono">{run.id}</span>
              <span className={`pill ${run.outcome === 'done' ? 'r-passed' : run.outcome === 'running' ? 'p-thread' : 'r-failed'}`}>{run.outcome}</span>
              <span className="hash">{run.started_at}{run.ended_at ? ` → ${run.ended_at}` : ''}</span>
              {thread ? <button className="btn pri" onClick={() => setPanel({ kind: 'thread', id: thread.id })}>Open thread</button> : null}
              {run.outcome !== 'running' ? (
                <button
                  className="btn"
                  onClick={() =>
                    void act(async () => {
                      const r = await api.runLog(id, run.id)
                      setLogs((c) => ({ ...c, [run.id]: r.text }))
                    })
                  }
                >
                  Show log
                </button>
              ) : null}
            </div>
            <div className="sbody">
              {run.outcome === 'running' ? <LiveLog id={id} runId={run.id} /> : null}
              {logs[run.id] !== undefined ? <pre className="doc">{logs[run.id] || '(no text output)'}</pre> : null}
            </div>
          </div>
        )
      })}
      <h4>Corpus</h4>
      {runner?.result ? (
        <p>{runner.result.totals.passed} green · {runner.result.totals.failed} red · {runner.result.totals.other} other</p>
      ) : (
        <p className="empty">No corpus run recorded for this worktree.</p>
      )}
      {failing.length ? (
        <ul>
          {failing.map(([key, r]) => (
            <li key={key}><span className="mono">{key}</span> — {r.status}{r.failure ? `: ${r.failure.message.split('\n')[0]}` : ''}</li>
          ))}
        </ul>
      ) : null}
      <h4>RESULT.md</h4>
      <DocTab title="RESULT.md" text={view.docs.result} />
    </>
  )
}

export function KitchenTab({ view }: { view: ChangeView }) {
  return (
    <>
      <p className="note">The agent's working files. They are not part of the review.</p>
      <details>
        <summary>design.md</summary>
        <DocTab title="design.md" text={view.docs.design} />
      </details>
      <details>
        <summary>tasks.md</summary>
        <DocTab title="tasks.md" text={view.docs.tasks} />
      </details>
    </>
  )
}
