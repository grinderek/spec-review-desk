import { describe, expect, it } from 'vitest'
import { createEventHub, type EventSourceLike } from './event-hub.ts'

// Review fix 4: one EventSource per tab carries every live update (the server's /api/events
// already relays every bus topic); run, thread and apply-run streams subscribe to their topic.
function fakeSource() {
  const opened: (EventSourceLike & { closed: boolean; emit: (data: string) => void })[] = []
  const open = (): EventSourceLike => {
    const source = {
      onmessage: null as ((event: { data: string }) => void) | null,
      closed: false,
      close() { this.closed = true },
      emit(data: string) { this.onmessage?.({ data }) },
    }
    opened.push(source)
    return source
  }
  return { opened, open }
}

describe('createEventHub', () => {
  it('opens one source for every subscriber and hands each only its topic ("*" gets all)', () => {
    const { opened, open } = fakeSource()
    const hub = createEventHub(open)
    const a: unknown[] = []
    const b: unknown[] = []
    const all: string[] = []
    const offA = hub.subscribe('irun:r_1', (m) => a.push(m.data))
    const offB = hub.subscribe('irun:r_2', (m) => b.push(m.data))
    const offAll = hub.subscribe('*', (m) => all.push(m.topic))
    expect(opened).toHaveLength(1)
    opened[0]!.emit(JSON.stringify({ topic: 'irun:r_1', data: { type: 'delta', text: 'x' } }))
    opened[0]!.emit(JSON.stringify({ topic: 'initiative', data: null }))
    opened[0]!.emit('not json')
    expect(a).toEqual([{ type: 'delta', text: 'x' }])
    expect(b).toEqual([])
    expect(all).toEqual(['irun:r_1', 'initiative'])
    offA()
    offB()
    expect(opened[0]!.closed).toBe(false)
    offAll()
    expect(opened[0]!.closed).toBe(true)
  })

  it('reopens after the last subscriber left, and an unsubscribe is idempotent', () => {
    const { opened, open } = fakeSource()
    const hub = createEventHub(open)
    const off = hub.subscribe('*', () => undefined)
    off()
    off()
    hub.subscribe('*', () => undefined)
    expect(opened).toHaveLength(2)
    expect(opened.map((s) => s.closed)).toEqual([true, false])
  })
})
