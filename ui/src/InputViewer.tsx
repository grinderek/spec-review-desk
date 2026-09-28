import { useQuery } from '@tanstack/react-query'
import { api, type InitiativeId, type InitiativeView } from './api.ts'
import { useAction } from './feedback.tsx'
import { inputKind } from './initiative-view.ts'
import { Markdown } from './Markdown.tsx'

type Input = InitiativeView['inputs'][number]

export function DraftActions({ id, file, onDiscarded }: { id: InitiativeId; file: string; onDiscarded?: () => void }) {
  const act = useAction()
  return (
    <>
      <button className="btn ok" onClick={() => void act(() => api.acceptDraft(id, file), `${file} accepted and committed`)}>Accept</button>
      <button
        className="btn bad"
        onClick={() => void act(() => api.discardDraft(id, file), `${file} discarded`).then((ok) => { if (ok) onDiscarded?.() })}
      >
        Discard
      </button>
    </>
  )
}

// Desk fixes item 4: an input — a research draft before Accept, or any other input — read on the
// initiative screen. Markdown is rendered, other text shown as is, a PDF framed, an image shown.
export function InputViewer({ id, input, onClose }: { id: InitiativeId; input: Input; onClose: () => void }) {
  const kind = inputKind(input.file)
  const textual = kind === 'markdown' || kind === 'text'
  const text = useQuery({ queryKey: ['input', id.wt, id.name, input.file], queryFn: () => api.inputText(id, input.file), enabled: textual })
  const url = api.inputUrl(id, input.file)
  let body
  if (textual) {
    if (text.error) body = <div className="banner bad">{text.error instanceof Error ? text.error.message : String(text.error)}</div>
    else if (text.data === undefined) body = <p className="empty">Loading {input.file}…</p>
    else body = kind === 'markdown' ? <Markdown text={text.data} /> : <pre className="doc">{text.data}</pre>
  } else if (kind === 'pdf') {
    body = <iframe className="pdfview" src={url} title={input.file} />
  } else if (kind === 'image') {
    body = <img className="imgview" src={url} alt={input.file} />
  } else {
    body = <p className="empty">The Desk cannot show {input.file}.</p>
  }
  return (
    <section className="viewer" aria-label={input.file}>
      <div className="toolbar">
        <b className="mono">{input.file}</b>
        {input.draft ? <span className="pill p-draft">draft</span> : null}
        {input.draft ? <DraftActions id={id} file={input.file} onDiscarded={onClose} /> : null}
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      {body}
    </section>
  )
}
