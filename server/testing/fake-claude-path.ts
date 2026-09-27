import { fileURLToPath } from 'node:url'

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
export const FAKE_DOCKER = fileURLToPath(new URL('./fake-docker.mjs', import.meta.url))
export const FAKE_OPENSPEC = fileURLToPath(new URL('./fake-openspec.mjs', import.meta.url))

const STRUCTURED_VARIABLES = [
  'FAKE_CLAUDE_REPLY', 'FAKE_CLAUDE_REPLY_FILE', 'FAKE_CLAUDE_REPLIES_FILE', 'FAKE_CLAUDE_STRUCTURED',
  'FAKE_CLAUDE_INVALID_REPLY', 'FAKE_CLAUDE_OMIT_STRUCTURED', 'FAKE_CLAUDE_TEXT_FILE', 'FAKE_CLAUDE_WRITES_FILE',
]

// Structured-mode variables must never leak from one test into the next.
export function resetFakeClaude(): void {
  for (const name of STRUCTURED_VARIABLES) delete process.env[name]
}
