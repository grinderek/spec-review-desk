import type { Query, QueryClient } from '@tanstack/react-query'

// The queries an action (useAction) can change: a change, the sidebar lists, the corpus, the
// runner, an initiative.
export const ACTION_KEYS: readonly string[] = ['change', 'changes', 'corpus', 'rules', 'runner', 'initiative', 'initiatives']
const affected = (query: Query): boolean => ACTION_KEYS.includes(String(query.queryKey[0]))

// How long an action's report waits for its refresh (review fix 5): a stalled or slow refetch
// must not keep "Working…" up and the action's controls disabled - the data lands when it lands.
export const REFRESH_LIMIT_MS = 5_000

// Refresh the business screen before reporting success. Sidebar lists and verification source
// scans update in the background; approving a card must not wait for unrelated repository scans.
// Runner controls explicitly wait for their own status instead.
export async function refreshAfterAction(client: QueryClient, limitMs = REFRESH_LIMIT_MS, waitForRunner = false): Promise<void> {
  const foreground = (query: Query): boolean => ['change', 'initiative', ...(waitForRunner ? ['runner'] : [])].includes(String(query.queryKey[0]))
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs) })
  try {
    await Promise.race([client.invalidateQueries({ predicate: foreground }), limit])
  } finally {
    clearTimeout(timer)
    void client.invalidateQueries({ predicate: query => affected(query) && !foreground(query) }).catch(() => undefined)
  }
}
