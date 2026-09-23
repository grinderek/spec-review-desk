import { useEffect, useRef } from 'react'

export const corpusKey = (file: string, title: string): string => `${file.split('/').pop() ?? file}::${title}`
export const cssId = (key: string): string => key.replace(/[^a-zA-Z0-9_-]/g, '_')

export const stripDiff = (text: string): string => text.replace(/```diff[\s\S]*?```/g, '').trim()

export function defaultSummary(text: string): string {
  const first = text.replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.trim()).find(Boolean)
  if (!first) return 'owner decision'
  return first.length > 72 ? `${first.slice(0, 71)}…` : first
}

export function useKeys(map: Record<string, () => void>): void {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      ref.current[e.key]?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
