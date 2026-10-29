import type { ChangesResponse, InitiativeSummary } from './api.ts'
import type { ProductOverview } from '../../server/products.ts'
import type { Selection } from './selection.ts'
import { progressLabel, statusSegments } from './initiative-view.ts'

interface SidebarProps {
  data: ChangesResponse | undefined
  products: ProductOverview[] | undefined
  initiatives: InitiativeSummary[] | undefined
  selected: Selection | null
  onSelect: (s: Selection) => void
}

export function Sidebar({ data, products, initiatives, selected, onSelect }: SidebarProps) {
  const isInitiative = (i: InitiativeSummary) => selected?.kind === 'initiative' && selected.id.wt === i.worktreeId && selected.id.name === i.name
  return (
    <nav className="pane side" aria-label="Changes">
      <div className="sideact">
        <button className="btn pri" aria-current={selected?.kind === 'new' ? 'true' : undefined} onClick={() => onSelect({ kind: 'new' })}>+ New feature</button>
        <button className="btn" aria-current={selected?.kind === 'describe' ? 'true' : undefined} onClick={() => onSelect({ kind: 'describe' })}>Описать существующий процесс</button>
      </div>
      {products?.length ? <section className="repo"><h2>Продукты</h2>{products.map(product => <button key={product.name} className="chg rules-link" aria-current={selected?.kind === 'product' && selected.name === product.name ? 'true' : undefined} onClick={() => onSelect({ kind: 'product', name: product.name })}>
        <span className="n">{product.title}</span><span className="meta">Состав продукта · {product.components.length} компонентов</span>
      </button>)}</section> : null}
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
              <h2>Действующие правила</h2>
              <button className="chg rules-link" aria-current={selected?.kind === 'rules' && selected.wt === wt.id ? 'true' : undefined} onClick={() => onSelect({ kind: 'rules', wt: wt.id })}>
                <span className="n">Правила продукта</span>
                <span className="meta">По процессам · без повторов пакетов</span>
              </button>
              {(['pending', 'approved', 'archive'] as const).map(group => {
                const changes = wt.changes.filter(change => change.archived ? group === 'archive' : change.reviewStatus === group)
                const buttons = changes.map((change) => {
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
                      {change.approved}/{change.total} scenarios · {change.openThreads} open{blocking}{change.reviewStatus === 'approved' ? ' · согласовано' : change.approvedAt ? ' · согласование не завершено' : ''}
                    </span>
                    <span className="bar"><i style={{ width: `${change.total ? Math.round((change.approved / change.total) * 100) : 0}%` }} /></span>
                  </button>
                )
                })
                if (group !== 'archive') return changes.length || group === 'pending' ? <div key={group}><h2>{group === 'approved' ? 'Согласовано' : 'Изменения на согласовании'}</h2>{buttons.length ? buttons : <p className="side-note">Нет изменений на согласовании</p>}</div> : null
                return changes.length ? <details className="history-group" key={group} open={changes.some(c => selected?.kind === 'change' && selected.id.wt === wt.id && selected.id.name === c.name) || undefined}>
                  <summary>История изменений ({changes.length})</summary>
                  <p className="side-note">Завершенные пакеты и этапы миграции</p>
                  {buttons}
                </details> : null
              })}
            </div>
          ))}
        </section>
      ))}
    </nav>
  )
}
