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
    const keys = message.topic === 'files' ? ['change', 'changes', 'corpus', 'rules', 'initiative', 'initiatives']
      : message.topic === 'change' ? ['change', 'changes', 'corpus', 'rules']
      : message.topic === 'initiative' ? ['initiative', 'initiatives', 'changes']
      : message.topic === 'runner' ? ['runner'] : []
    const data = message.data as { worktreeId?: string } | null
    void client.invalidateQueries({ predicate: query => keys.includes(String(query.queryKey[0]))
      && (!data?.worktreeId || query.queryKey.length === 1 || query.queryKey[1] === data.worktreeId) })
  })
}
