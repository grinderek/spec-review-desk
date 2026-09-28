import type { Query, QueryClient } from '@tanstack/react-query'

// The queries an action (useAction) can change: a change, the sidebar lists, the corpus, the
// runner, an initiative.
export const ACTION_KEYS: readonly string[] = ['change', 'changes', 'corpus', 'runner', 'initiative', 'initiatives']
const affected = (query: Query): boolean => ACTION_KEYS.includes(String(query.queryKey[0]))

// Desk fixes item 1: success is announced on the refreshed screen, not before its refetch has even
// started. Resolves once the active affected queries were refetched — also when the mutation's own
// live-update event (SSE) cancels and restarts that refetch meanwhile (refresh.test.ts pins it).
export async function refreshAfterAction(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ predicate: affected })
}
