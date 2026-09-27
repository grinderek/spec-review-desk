import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'ui/src/**/*.test.ts'],
    testTimeout: 20_000,
    // One temp root for the whole run, removed in teardown (final review I5).
    globalSetup: ['server/testing/tmp-root.ts'],
    coverage: { include: ['server/**/*.ts'], exclude: ['server/**/*.test.ts', 'server/testing/**', 'server/main.ts'] },
  },
})
