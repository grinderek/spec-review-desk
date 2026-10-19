import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'

// New commands may use schema defaults. They may not silently discard a misspelled or
// renamed field, including a field nested inside an execution, input or Git intent.
function requireKnownFields(raw: unknown, prepared: unknown, at = '(root)'): void {
  if (!raw || typeof raw !== 'object') return
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => requireKnownFields(value, (prepared as unknown[] | undefined)?.[index], `${at}[${index}]`))
    return
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!prepared || typeof prepared !== 'object' || !Object.hasOwn(prepared, key)) throw new Error(`Unsupported journal field ${at}.${key}`)
    requireKnownFields(value, (prepared as Record<string, unknown>)[key], `${at}.${key}`)
  }
}
export function prepareJournalRecord<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const prepared = schema.parse(raw)
  requireKnownFields(raw, prepared)
  return prepared
}

// Persisted history already contains the complete target representation. Reading never
// inserts defaults, removes fields or performs an implicit migration to another schema.
// A schema change needs an explicit version decision; unsupported history fails closed.
export function decodeJournalRecord<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const decoded = schema.parse(raw)
  if (!isDeepStrictEqual(raw, decoded)) throw new Error('Unsupported journal representation: reading would change persisted fields or insert defaults')
  return decoded
}
