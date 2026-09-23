import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './api.ts'
import { App } from './App.tsx'
import { ToastProvider } from './feedback.tsx'
import { ensureSession } from './session.ts'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
})

void ensureSession()
  .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  .then((sessionError) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <App sessionError={sessionError} />
          </ToastProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
