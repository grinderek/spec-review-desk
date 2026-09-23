import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { BusEvent, EventBus } from '../events.ts'

export function sseFromBus(c: Context, bus: EventBus, topic: string): Response {
  return streamSSE(c, async (stream) => {
    const queue: BusEvent[] = []
    let wake: (() => void) | null = null
    const off = bus.subscribe(topic, (event) => {
      queue.push(event)
      wake?.()
    })
    stream.onAbort(() => {
      off()
      wake?.()
    })
    await stream.writeSSE({ data: JSON.stringify({ topic: 'hello', data: null }) })
    while (!stream.aborted) {
      const next = queue.shift()
      if (next) {
        await stream.writeSSE({ data: JSON.stringify(next) })
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 15_000)
      })
      wake = null
      if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' })
    }
    off()
  })
}
