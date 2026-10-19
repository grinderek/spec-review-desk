import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { loadConfig } from '../server/config.ts'

export default defineConfig(async ({ command }) => {
  const backendPort = command === 'serve'
    ? (await loadConfig(process.env.SPEC_REVIEW_CONFIG || 'config.yaml')).port
    : 4600
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true } },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  }
})
