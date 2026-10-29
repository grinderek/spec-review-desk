import type { ChangeId, InitiativeId } from './api.ts'

// What the main pane shows (spec B §8): #/<wt>/<change> · #/i/<wt>/<initiative> · #/new
export type Selection = { kind: 'describe'; product?: string } | { kind: 'product'; name: string } | { kind: 'change'; id: ChangeId } | { kind: 'initiative'; id: InitiativeId } | { kind: 'rules'; wt: string; file?: string } | { kind: 'new' }

export function readHash(hash: string): Selection | null {
  const clean = hash.replace(/^#\/?/, '')
  if (clean === 'new') return { kind: 'new' }
  const [head, ...rest] = clean.split('/')
  if (head === 'describe') return { kind: 'describe', ...(rest[0] ? { product: decodeURIComponent(rest[0]) } : {}) }
  if (head === 'products' && rest[0]) return { kind: 'product', name: decodeURIComponent(rest[0]) }
  if (head === 'rules' && rest[0]) return { kind: 'rules', wt: rest[0], ...(rest.length > 1 ? { file: decodeURIComponent(rest.slice(1).join('/')) } : {}) }
  if (head === 'i' && rest.length >= 2) return { kind: 'initiative', id: { wt: rest[0]!, name: decodeURIComponent(rest.slice(1).join('/')) } }
  return head && rest.length ? { kind: 'change', id: { wt: head, name: decodeURIComponent(rest.join('/')) } } : null
}

export const hashOf = (s: Selection): string =>
  s.kind === 'describe' ? `#/describe${s.product ? `/${encodeURIComponent(s.product)}` : ''}` : s.kind === 'product' ? `#/products/${encodeURIComponent(s.name)}` : s.kind === 'new' ? '#/new' : s.kind === 'rules' ? `#/rules/${s.wt}${s.file ? `/${encodeURIComponent(s.file)}` : ''}` : s.kind === 'initiative' ? `#/i/${s.id.wt}/${encodeURIComponent(s.id.name)}` : `#/${s.id.wt}/${encodeURIComponent(s.id.name)}`
