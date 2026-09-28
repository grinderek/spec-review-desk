import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshAfterAction } from './refresh.ts'

// Desk fixes item 1: an action reports success only once the screen's queries hold fresh data.
const clients: QueryClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.clear()
})

function setup(key: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  let version = 0
  let delay = 20
  const observer = new QueryObserver(client, {
    queryKey: [key, 'wt', 'name'],
    queryFn: async () => {
      const v = version
      await new Promise((resolve) => setTimeout(resolve, delay))
      return v
    },
  })
  const unsubscribe = observer.subscribe(() => undefined)
  return {
    client,
    data: () => client.getQueryData<number>([key, 'wt', 'name']),
    bump: () => { version += 1 },
    slow: (ms: number) => { delay = ms },
    unsubscribe,
  }
}

describe('refreshAfterAction', () => {
  it('resolves only after the active queries of the screen were refetched', async () => {
    const s = setup('initiative')
    await expect.poll(s.data).toBe(0)
    s.bump()
    await refreshAfterAction(s.client)
    expect(s.data()).toBe(1)
    s.unsubscribe()
  })

  it('waits for a refetch a live-update invalidation restarted meanwhile', async () => {
    const s = setup('changes')
    await expect.poll(s.data).toBe(0)
    s.bump()
    s.slow(60)
    const done = refreshAfterAction(s.client)
    // The SSE event of the same mutation lands while the refetch is in flight: it cancels and
    // restarts it; the action must still wait for the restarted one.
    await new Promise((resolve) => setTimeout(resolve, 10))
    s.bump()
    void s.client.invalidateQueries({ queryKey: ['changes'] })
    await done
    expect(s.data()).toBe(2)
    s.unsubscribe()
  })

  it('leaves queries of other screens alone', async () => {
    const s = setup('sandbox')
    await expect.poll(s.data).toBe(0)
    s.bump()
    await refreshAfterAction(s.client)
    expect(s.data()).toBe(0)
    s.unsubscribe()
  })
})
