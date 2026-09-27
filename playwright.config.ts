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
    // Without this, Playwright SIGKILLs the process group on teardown — the fixture never gets a
    // chance to run its own exit handler, which is what removes its temp git repo and replies/writes
    // files under /tmp (see e2e/serve-fixture.ts). SIGTERM first gives that handler the chance; the
    // timeout still SIGKILLs if it somehow doesn't exit in time.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
})
