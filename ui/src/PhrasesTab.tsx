import type { ChangeView } from '../../server/change-view.ts'
import type { ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'

export function PhrasesTab({ id, view, setPanel }: { id: ChangeId; view: ChangeView; setPanel: (t: PanelTarget) => void }) {
  const threadFor = (key: string) => view.review.threads.find((t) => t.anchor === 'phrase' && t.ref === key && t.status !== 'resolved')
  const withEvents = view.phrases.some((p) => p.event !== null)
  return (
    <>
      <p className="note">Технические шаблоны связывают текст карточек с операциями адаптера. Отдельный approve не требуется. Ошибки выражений, неизвестные шаги и нарушения структуры сценария блокируют готовность пакета. Корректность каталога не подтверждает выполнение правил адаптером.</p>
      {view.proposedPreamble ? <p className="note">{view.proposedPreamble}</p> : null}
      <details>
        <summary className="hash">Catalog conventions (features/STEPS.md)</summary>
        <pre className="doc">{view.catalogPreamble || 'No preamble.'}</pre>
      </details>
      {view.phrases.length === 0 ? <p className="empty">This change adds no step phrases.</p> : null}
      <div className="tablewrap">
        <table className="list">
          <thead>
            <tr><th /><th>Шаблон</th><th>Описание</th>{withEvents ? <th>Event / Command</th> : null}<th>Использований</th><th>Проверка</th></tr>
          </thead>
          <tbody>
            {view.phrases.map((p) => {
              const thread = threadFor(p.key)
              return (
                <tr key={p.key}>
                  <td className="mono">{p.kind === 'extension' ? <span className="pill p-ext">extension</span> : p.keyword}</td>
                  <td className="mono">
                    {p.phrase} {p.note ? <span className="hash">{p.note}</span> : null}
                  </td>
                  <td>{p.meaning}</td>
                  {withEvents ? <td className="mono">{p.event ?? ''}</td> : null}
                  <td>{p.kind === 'extension' ? '-' : `${p.usedBy}×`}</td>
                  <td>
                    <div className="row">
                      {p.compileError ? <span className="fail">{p.compileError}</span> : <span className="pill">Выражение корректно</span>}
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
