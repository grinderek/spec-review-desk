import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.{ts,tsx}', 'ui/src/**/*.test.{ts,tsx}'],
    // Tests are added only at the owner's explicit request; an empty suite is expected.
    passWithNoTests: true,
    testTimeout: 20_000,
    // One temp root for the whole run, removed in teardown (final review I5).
    globalSetup: ['server/testing/tmp-root.ts'],
    coverage: { include: ['server/**/*.ts'], exclude: ['server/**/*.test.ts', 'server/testing/**', 'server/main.ts'] },
  },
})
