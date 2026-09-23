import type { ChangeView } from '../../server/change-view.ts'

export function DecisionsTab({ view, onGoto }: { view: ChangeView; onGoto: (key: string) => void }) {
  const decisions = view.features
    .flatMap((f) => f.scenarios.flatMap((s) => s.decisions.map((d) => ({ ...d, key: s.key, title: s.title }))))
    .sort((a, b) => b.date.localeCompare(a.date) || a.line - b.line)
  if (decisions.length === 0) return <p className="empty">No "# Owner decision" comments in this change yet.</p>
  return (
    <>
      <p className="note">Parsed from <code># Owner decision &lt;date&gt;:</code> comments, with the commit that introduced each one.</p>
      <ol className="dlog">
        {decisions.map((d) => (
          <li key={`${d.key}:${d.line}`}>
            <div className="hash">{d.date}{d.tag ? ` (${d.tag})` : ''}{d.commit ? ` · ${d.commit}` : ''}</div>
            <div>{d.text}</div>
            <button className="linkbtn" onClick={() => onGoto(d.key)}>→ {d.title}</button>
          </li>
        ))}
      </ol>
    </>
  )
}
