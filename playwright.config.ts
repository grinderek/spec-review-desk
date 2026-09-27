import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Both specs drive one server and one fixture repo.
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4620' },
  webServer: {
    command: 'npx tsx e2e/serve-fixture.ts',
    url: 'http://127.0.0.1:4620/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
