export function DocTab({ title, text }: { title: string; text: string | null }) {
  return text ? <pre className="doc" aria-label={title}>{text}</pre> : <p className="empty">{title} is not present in this change.</p>
}
