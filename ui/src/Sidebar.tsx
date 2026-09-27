import type { ChangesResponse, InitiativeSummary } from './api.ts'
import type { Selection } from './selection.ts'
import { progressLabel, statusSegments } from './initiative-view.ts'

interface SidebarProps {
  data: ChangesResponse | undefined
  initiatives: InitiativeSummary[] | undefined
  selected: Selection | null
  onSelect: (s: Selection) => void
}

export function Sidebar({ data, initiatives, selected, onSelect }: SidebarProps) {
  const isInitiative = (i: InitiativeSummary) => selected?.kind === 'initiative' && selected.id.wt === i.worktreeId && selected.id.name === i.name
  return (
    <nav className="pane side" aria-label="Changes">
      <div className="sideact">
        <button className="btn pri" aria-current={selected?.kind === 'new' ? 'true' : undefined} onClick={() => onSelect({ kind: 'new' })}>+ New feature</button>
      </div>
      {initiatives?.length ? (
        <section className="repo">
          <h2>Initiatives</h2>
          {initiatives.map((i) => (
            <button
              key={`${i.worktreeId}/${i.name}`}
              className="chg ini"
              aria-current={isInitiative(i) ? 'true' : undefined}
              onClick={() => onSelect({ kind: 'initiative', id: { wt: i.worktreeId, name: i.name } })}
            >
              <span className="n">{i.name}</span>
              <span className={`dot ${i.blockingDecisions ? 'warn' : i.applied === i.total && i.total ? 'ok' : ''}`} />
              <span className="meta">
                {i.repo} · {progressLabel(i)}
                {i.blockingDecisions ? ` · ${i.blockingDecisions} blocking` : ''}
                {i.running ? ' · running' : ''}
              </span>
              <span className="segbar" aria-hidden="true">
                {statusSegments(i).map((seg) => <i key={seg.status} className={`seg s-${seg.status}`} style={{ flexGrow: seg.count }} />)}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {!data ? <p className="empty">Loading changes…</p> : null}
      {data && data.repos.length === 0 ? <p className="empty">No behavior-driven changes found in the configured repos.</p> : null}
      {data?.repos.map((repo) => (
        <section key={repo.repo} className="repo">
          <h2>{repo.repo}</h2>
          {repo.worktrees.map((wt) => (
            <div key={wt.id}>
              <div className="wt" title={wt.path}>{wt.branch ?? 'detached'} · {wt.head}</div>
              {wt.changes.map((change) => {
                const current = selected?.kind === 'change' && selected.id.wt === wt.id && selected.id.name === change.name
                const tone = change.ready ? 'ok' : change.openThreads || change.blockingDecisions ? 'warn' : ''
                const blocking = change.blockingDecisions ? ` · ${change.blockingDecisions} blocking decision${change.blockingDecisions > 1 ? 's' : ''}` : ''
                return (
                  <button key={change.name} className="chg" aria-current={current ? 'true' : undefined} onClick={() => onSelect({ kind: 'change', id: { wt: wt.id, name: change.name } })}>
                    <span className="n">{change.name}</span>
                    <span className={`dot ${tone}`} />
                    <span className="meta">
                      {change.initiative ? <span className="itag">{change.initiative}</span> : null}
                      {change.archived ? 'archived · ' : ''}
                      {change.approved}/{change.total} scenarios · {change.openThreads} open{blocking}{change.approvedAt ? ' · approval recorded' : ''}
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
