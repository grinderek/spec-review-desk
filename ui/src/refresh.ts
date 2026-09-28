import type { Query, QueryClient } from '@tanstack/react-query'

// The queries an action (useAction) can change: a change, the sidebar lists, the corpus, the
// runner, an initiative.
export const ACTION_KEYS: readonly string[] = ['change', 'changes', 'corpus', 'runner', 'initiative', 'initiatives']
const affected = (query: Query): boolean => ACTION_KEYS.includes(String(query.queryKey[0]))

// How long an action's report waits for its refresh (review fix 5): a stalled or slow refetch
// must not keep "Working…" up and the action's controls disabled — the data lands when it lands.
export const REFRESH_LIMIT_MS = 5_000

// Desk fixes item 1: success is announced on the refreshed screen, not before its refetch has even
// started. Resolves once the active affected queries were refetched — also when the mutation's own
// live-update event (SSE) cancels and restarts that refetch meanwhile (refresh.test.ts pins it) —
// or after `limitMs`, whichever comes first.
export async function refreshAfterAction(client: QueryClient, limitMs = REFRESH_LIMIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs) })
  try {
    await Promise.race([client.invalidateQueries({ predicate: affected }), limit])
  } finally {
    clearTimeout(timer)
  }
}
