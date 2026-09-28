// Review fix 4: one EventSource per tab. Chrome allows 6 HTTP/1.1 connections per host, shared by
// every Desk tab, and an open EventSource holds one for good — a stream per run card, thread and
// apply run on top of /api/events could stall every fetch until a reload. The server's /api/events
// already relays every bus topic ({topic, data} frames), so each consumer subscribes to its topic
// here instead of opening its own stream. The source opens with the first subscriber and closes
// with the last.
export interface StreamMessage { topic: string; data: unknown }
export interface EventSourceLike { onmessage: ((event: { data: string }) => void) | null; close: () => void }
export type Listener = (message: StreamMessage) => void
export interface EventHub { subscribe: (topic: string, listener: Listener) => () => void }

export function createEventHub(open: () => EventSourceLike): EventHub {
  const listeners = new Set<{ topic: string; listener: Listener }>()
  let source: EventSourceLike | null = null
  const dispatch = (event: { data: string }): void => {
    let message: StreamMessage
    try {
      message = JSON.parse(event.data) as StreamMessage
    } catch {
      return
    }
    for (const entry of [...listeners]) {
      if (entry.topic === '*' || entry.topic === message.topic) entry.listener(message)
    }
  }
  return {
    subscribe(topic, listener) {
      const entry = { topic, listener }
      listeners.add(entry)
      if (!source) {
        source = open()
        source.onmessage = dispatch
      }
      return () => {
        if (!listeners.delete(entry) || listeners.size > 0) return
        source?.close()
        source = null
      }
    },
  }
}
