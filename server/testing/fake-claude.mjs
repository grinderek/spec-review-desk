#!/usr/bin/env node
// Test double for the claude CLI: prints stream-json events, driven by FAKE_CLAUDE_* variables.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const prompt = readFileSync(0, 'utf8')
const sessions = process.env.FAKE_CLAUDE_SESSIONS ?? path.join(process.cwd(), '.fake-claude-sessions')
mkdirSync(sessions, { recursive: true })
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, prompt, cwd: process.cwd() })}\n`)
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

const resume = flag('--resume')
const id = resume ?? flag('--session-id')
if (resume && !existsSync(path.join(sessions, resume))) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`)
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, result: '', session_id: resume })
  process.exit(1)
}
writeFileSync(path.join(sessions, id), 'known')
emit({ type: 'system', subtype: 'init', session_id: id })

const mode = process.env.FAKE_CLAUDE_MODE ?? 'answer'
if (mode === 'hang') {
  setInterval(() => undefined, 1000)
} else {
  const text = process.env.FAKE_CLAUDE_TEXT_FILE
    ? readFileSync(process.env.FAKE_CLAUDE_TEXT_FILE, 'utf8')
    : (process.env.FAKE_CLAUDE_TEXT ?? 'pong')
  for (const chunk of text.match(/[\s\S]{1,40}/g) ?? []) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }, session_id: id })
  }
  const failed = mode === 'fail'
  emit({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, num_turns: 1, result: failed ? 'boom' : text, session_id: id })
  process.exit(failed ? 1 : 0)
}
