import { fileURLToPath } from 'node:url'

export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))
export const FAKE_OPENSPEC = fileURLToPath(new URL('./fake-openspec.mjs', import.meta.url))

const STRUCTURED_VARIABLES = [
  'FAKE_CODEX_REPLY', 'FAKE_CODEX_REPLY_FILE', 'FAKE_CODEX_REPLIES_FILE', 'FAKE_CODEX_STRUCTURED',
  'FAKE_CODEX_INVALID_REPLY', 'FAKE_CODEX_OMIT_STRUCTURED', 'FAKE_CODEX_TEXT_FILE', 'FAKE_CODEX_WRITES_FILE',
  'FAKE_CODEX_RESULT_SAFE', 'FAKE_CODEX_HANG_MATCH', 'FAKE_CODEX_HANG_COUNT_FILE',
]

// Structured-mode variables must never leak from one test into the next.
export function resetFakeCodex(): void {
  for (const name of STRUCTURED_VARIABLES) delete process.env[name]
}
