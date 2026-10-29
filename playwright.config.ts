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
    // Wait for our fixture's readiness marker. Probing an unused loopback port before
    // launch can hang in WSL networking, outside Playwright's startup timeout.
    wait: { stdout: /e2e fixture repo:/ },
    reuseExistingServer: false,
    timeout: 60_000,
    // The fixture needs SIGTERM to stop detached workers before deleting their temporary artifacts.
    // Its own bounded teardown retains artifacts if inactivity cannot be proven.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
})
