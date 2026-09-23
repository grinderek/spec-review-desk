export interface BusEvent { topic: string; data: unknown }
type Listener = (event: BusEvent) => void

export class EventBus {
  #listeners = new Set<{ topic: string; fn: Listener }>()

  publish(topic: string, data: unknown): void {
    for (const listener of [...this.#listeners]) {
      if (listener.topic === '*' || listener.topic === topic) listener.fn({ topic, data })
    }
  }

  subscribe(topic: string, fn: Listener): () => void {
    const entry = { topic, fn }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }
}
