import { Markdown } from './Markdown.tsx'

export function DocTab({ title, text }: { title: string; text: string | null }) {
  return text ? <div aria-label={title}><Markdown text={text} /></div> : <p className="empty">{title} is not present in this change.</p>
}
