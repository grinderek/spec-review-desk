import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

export interface StreamMessage { topic: string; data: unknown }

export function useEventStream(url: string | null, onMessage: (message: StreamMessage) => void): void {
  const handler = useRef(onMessage)
  handler.current = onMessage
  useEffect(() => {
    if (!url) return
    const source = new EventSource(url)
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(event.data) as StreamMessage)
      } catch {
        // ignore malformed frames
      }
    }
    return () => source.close()
  }, [url])
}

export function useInvalidation(): void {
  const client = useQueryClient()
  useEventStream('/api/events', (message) => {
    if (message.topic === 'files' || message.topic === 'change') {
      for (const key of ['change', 'changes', 'corpus']) void client.invalidateQueries({ queryKey: [key] })
    }
    if (message.topic === 'runner') void client.invalidateQueries({ queryKey: ['runner'] })
  })
}
