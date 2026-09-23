import type { ChangeView } from '../../server/change-view.ts'
import { api, type ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { useAction } from './feedback.tsx'
import { StatusPill } from './ScenarioCard.tsx'

export function PhrasesTab({ id, view, setPanel }: { id: ChangeId; view: ChangeView; setPanel: (t: PanelTarget) => void }) {
  const act = useAction()
  const threadFor = (key: string) => view.review.threads.find((t) => t.anchor === 'phrase' && t.ref === key && t.status !== 'resolved')
  return (
    <>
      {view.proposedPreamble ? <p className="note">{view.proposedPreamble}</p> : null}
      <details>
        <summary className="hash">Catalog conventions (features/STEPS.md)</summary>
        <pre className="doc">{view.catalogPreamble || 'No preamble.'}</pre>
      </details>
      {view.phrases.length === 0 ? <p className="empty">This change adds no step phrases.</p> : null}
      <div className="tablewrap">
        <table className="list">
          <thead>
            <tr><th /><th>Phrase</th><th>Meaning</th><th>Used</th><th /></tr>
          </thead>
          <tbody>
            {view.phrases.map((p) => {
              const thread = threadFor(p.key)
              return (
                <tr key={p.key}>
                  <td className="mono">{p.kind === 'extension' ? <span className="pill p-ext">extension</span> : p.keyword}</td>
                  <td className="mono">
                    {p.phrase} {p.note ? <span className="hash">{p.note}</span> : null}
                    {p.compileError ? <div className="fail">{p.compileError}</div> : null}
                  </td>
                  <td>{p.meaning}</td>
                  <td>{p.kind === 'extension' ? '—' : `${p.usedBy}×`}</td>
                  <td>
                    <div className="row">
                      <StatusPill effective={p.effective} />
                      {view.archived ? null : p.effective.status === 'approved' ? (
                        <button className="btn" onClick={() => void act(() => api.revokePhrase(id, p.key), 'Approval revoked')}>Revoke</button>
                      ) : (
                        <button className="btn ok" onClick={() => void act(() => api.approvePhrase(id, p.key), 'Phrase approved')}>Approve</button>
                      )}
                      {view.archived && !thread ? null : (
                        <button className="btn pri" onClick={() => setPanel(thread ? { kind: 'thread', id: thread.id } : { kind: 'new', anchor: 'phrase', ref: p.key, title: p.phrase })}>
                          {thread ? 'Thread' : 'Ask'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
