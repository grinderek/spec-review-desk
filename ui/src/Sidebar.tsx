import type { ChangeId, ChangesResponse } from './api.ts'

export function Sidebar({ data, selected, onSelect }: { data: ChangesResponse | undefined; selected: ChangeId | null; onSelect: (id: ChangeId) => void }) {
  if (!data) return <nav className="pane side"><p className="empty">Loading changes…</p></nav>
  return (
    <nav className="pane side" aria-label="Changes">
      {data.repos.length === 0 ? <p className="empty">No behavior-driven changes found in the configured repos.</p> : null}
      {data.repos.map((repo) => (
        <section key={repo.repo} className="repo">
          <h2>{repo.repo}</h2>
          {repo.worktrees.map((wt) => (
            <div key={wt.id}>
              <div className="wt" title={wt.path}>{wt.branch ?? 'detached'} · {wt.head}</div>
              {wt.changes.map((change) => {
                const current = selected?.wt === wt.id && selected.name === change.name
                const tone = change.ready ? 'ok' : change.openThreads ? 'warn' : ''
                return (
                  <button key={change.name} className="chg" aria-current={current ? 'true' : undefined} onClick={() => onSelect({ wt: wt.id, name: change.name })}>
                    <span className="n">{change.name}</span>
                    <span className={`dot ${tone}`} />
                    <span className="meta">
                      {change.archived ? 'archived · ' : ''}
                      {change.approved}/{change.total} scenarios · {change.openThreads} open{change.approvedAt ? ' · approval recorded' : ''}
                    </span>
                    <span className="bar"><i style={{ width: `${change.total ? Math.round((change.approved / change.total) * 100) : 0}%` }} /></span>
                  </button>
                )
              })}
            </div>
          ))}
        </section>
      ))}
    </nav>
  )
}
