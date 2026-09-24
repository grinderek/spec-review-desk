import { Fragment, type ReactNode } from 'react'
import { type Inline, parseMarkdown } from './markdown.ts'

function inlines(parts: Inline[]): ReactNode {
  return parts.map((p, i) => (p.kind === 'bold' ? <strong key={i}>{p.text}</strong> : p.kind === 'code' ? <code key={i}>{p.text}</code> : <Fragment key={i}>{p.text}</Fragment>))
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{inlines(b.inlines)}</p>
        if (b.kind === 'h') return <h5 key={i}>{inlines(b.inlines)}</h5>
        if (b.kind === 'code') return <pre key={i} className="doc">{b.text}</pre>
        const items = b.items.map((it, j) => <li key={j}>{inlines(it)}</li>)
        return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
      })}
    </div>
  )
}
