import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'ui/src/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: { include: ['server/**/*.ts'], exclude: ['server/**/*.test.ts', 'server/testing/**', 'server/main.ts'] },
  },
})
