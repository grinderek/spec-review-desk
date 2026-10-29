import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'

export function TableFrame({ children, label = 'Таблица' }: { children: ReactNode; label?: string }) {
  return <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>
}

const components: Components = {
  table: ({ node: _node, children, ...props }) => <TableFrame><table {...props}>{children}</table></TableFrame>,
  pre: ({ node: _node, ...props }) => <pre className="doc" {...props} />,
  a: ({ node: _node, href, children, ...props }) => href
    ? <a {...props} href={href} {...(!href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
    : <span>{children}</span>,
  // Documents may refer to external illustrations; loading them requires following the link.
  img: ({ src, alt }) => src?.startsWith('/api/') && !src.includes('\\')
    ? <img src={src} alt={alt ?? ''} loading="lazy" />
    : src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'Открыть изображение'}</a> : <span>{alt}</span>,
}

export function Markdown({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}
    urlTransform={url => defaultUrlTransform(url)}>{text}</ReactMarkdown></div>
}
