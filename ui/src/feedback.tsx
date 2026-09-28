import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { refreshAfterAction } from './refresh.ts'

type Tone = 'ok' | 'bad'
interface Feedback { show: (text: string, tone?: Tone) => void; busy: (delta: 1 | -1) => void }
const ToastContext = createContext<Feedback>({ show: () => undefined, busy: () => undefined })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null)
  // Actions in flight: a slow one (a run start assembling its room) shows "Working…" at once.
  const [pending, setPending] = useState(0)
  const show = useCallback((text: string, tone: Tone = 'ok') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast((current) => (current?.text === text ? null : current)), 4000)
  }, [])
  const busy = useCallback((delta: 1 | -1) => setPending((n) => Math.max(0, n + delta)), [])
  return (
    <ToastContext.Provider value={{ show, busy }}>
      {children}
      {toast ? (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      ) : pending > 0 ? (
        <div className="toast busy" role="status">Working…</div>
      ) : null}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext).show

// Runs a mutation, then refreshes the screen, and only then reports success: the toast never
// appears over stale data (Desk fixes item 1). A failure is reported at once; the screen is still
// refreshed, since a failed action may have changed something before it failed.
export function useAction() {
  const client = useQueryClient()
  const { show, busy } = useContext(ToastContext)
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      busy(1)
      try {
        await fn()
        await refreshAfterAction(client)
        if (success) show(success, 'ok')
        return true
      } catch (error) {
        show(error instanceof Error ? error.message : String(error), 'bad')
        void refreshAfterAction(client)
        return false
      } finally {
        busy(-1)
      }
    },
    [client, show, busy],
  )
}
