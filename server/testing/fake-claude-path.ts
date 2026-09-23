import { fileURLToPath } from 'node:url'

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
