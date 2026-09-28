import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { createEventHub, type EventSourceLike, type StreamMessage } from './event-hub.ts'

export type { StreamMessage }

// The tab's one live stream (event-hub.ts); `topic` null subscribes to nothing, '*' to every topic.
const hub = createEventHub(() => {
  const source = new EventSource('/api/events')
  const like: EventSourceLike = { onmessage: null, close: () => source.close() }
  source.onmessage = (event: MessageEvent<string>) => like.onmessage?.(event)
  return like
})

export function useEventStream(topic: string | null, onMessage: (message: StreamMessage) => void): void {
  const handler = useRef(onMessage)
  handler.current = onMessage
  useEffect(() => {
    if (!topic) return
    return hub.subscribe(topic, (message) => handler.current(message))
  }, [topic])
}

export function useInvalidation(): void {
  const client = useQueryClient()
  useEventStream('*', (message) => {
    if (message.topic === 'files' || message.topic === 'change') {
      for (const key of ['change', 'changes', 'corpus']) void client.invalidateQueries({ queryKey: [key] })
    }
    if (message.topic === 'runner') void client.invalidateQueries({ queryKey: ['runner'] })
    if (message.topic === 'initiative' || message.topic === 'files') {
      for (const key of ['initiative', 'initiatives', 'changes']) void client.invalidateQueries({ queryKey: [key] })
    }
  })
}
