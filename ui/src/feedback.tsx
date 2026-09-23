import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'

type Tone = 'ok' | 'bad'
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null)
  const show = useCallback((text: string, tone: Tone = 'ok') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast((current) => (current?.text === text ? null : current)), 4000)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

export function useAction() {
  const client = useQueryClient()
  const toast = useToast()
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      try {
        await fn()
        if (success) toast(success, 'ok')
        return true
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'bad')
        return false
      } finally {
        for (const key of ['change', 'changes', 'corpus', 'runner']) void client.invalidateQueries({ queryKey: [key] })
      }
    },
    [client, toast],
  )
}
