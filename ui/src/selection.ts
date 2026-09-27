import type { ChangeId, InitiativeId } from './api.ts'

// What the main pane shows (spec B §8): #/<wt>/<change> · #/i/<wt>/<initiative> · #/new
export type Selection = { kind: 'change'; id: ChangeId } | { kind: 'initiative'; id: InitiativeId } | { kind: 'new' }

export function readHash(hash: string): Selection | null {
  const clean = hash.replace(/^#\/?/, '')
  if (clean === 'new') return { kind: 'new' }
  const [head, ...rest] = clean.split('/')
  if (head === 'i' && rest.length >= 2) return { kind: 'initiative', id: { wt: rest[0]!, name: decodeURIComponent(rest.slice(1).join('/')) } }
  return head && rest.length ? { kind: 'change', id: { wt: head, name: decodeURIComponent(rest.join('/')) } } : null
}

export const hashOf = (s: Selection): string =>
  s.kind === 'new' ? '#/new' : s.kind === 'initiative' ? `#/i/${s.id.wt}/${encodeURIComponent(s.id.name)}` : `#/${s.id.wt}/${encodeURIComponent(s.id.name)}`
