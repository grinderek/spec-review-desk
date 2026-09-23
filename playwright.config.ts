import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4620' },
  webServer: {
    command: 'npx tsx e2e/serve-fixture.ts',
    url: 'http://127.0.0.1:4620/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
