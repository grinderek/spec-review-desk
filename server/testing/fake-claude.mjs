#!/usr/bin/env node
// Test double for the claude CLI: prints stream-json events, driven by FAKE_CLAUDE_* variables.
// With --json-schema it behaves like the real CLI's structured mode (spike 2026-09-24): the reply
// streams as input_json_delta chunks of an internal StructuredOutput tool call, after a first turn
// with narration and a Read call, and the result carries structured_output.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
if (args.includes('--version')) {
  process.stdout.write('fake-claude 0.0.0\n')
  process.exit(0)
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
const structuredMode = process.env.FAKE_CLAUDE_STRUCTURED ?? 'valid'
const structured = args.includes('--json-schema') && structuredMode !== 'off'
const readText = () =>
  process.env.FAKE_CLAUDE_TEXT_FILE ? readFileSync(process.env.FAKE_CLAUDE_TEXT_FILE, 'utf8') : (process.env.FAKE_CLAUDE_TEXT ?? 'pong')
const DIFF_BLOCK = /```diff\r?\n([\s\S]*?)```/
const INVALID = {
  answer: 'Invalid on purpose.',
  patch: null,
  decisions: [{
    id: 'storage',
    question: 'Which storage?',
    scope: { kind: 'change' },
    options: [{ id: 'sqlite_path', label: 'SQLite', consequence: 'One file.' }, { id: 'postgres', label: 'Postgres', consequence: 'A server.' }],
    recommended: 'sqlite',
    blocking: true,
  }],
  resolves: [],
  status: 'answered',
}

function defaultReply(text) {
  const fenced = text.match(DIFF_BLOCK)
  return {
    answer: fenced ? text.replace(DIFF_BLOCK, '').trim() : text,
    patch: fenced ? fenced[1] : null,
    decisions: [],
    resolves: [],
    status: args.includes('acceptEdits') ? 'done' : 'answered',
  }
}

function scriptedReply() {
  if (process.env.FAKE_CLAUDE_REPLIES_FILE) {
    const hit = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLIES_FILE, 'utf8')).find((entry) => prompt.includes(entry.match))
    if (hit) return hit.reply
  }
  if (process.env.FAKE_CLAUDE_REPLY_FILE) return JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLY_FILE, 'utf8'))
  if (process.env.FAKE_CLAUDE_REPLY) return JSON.parse(process.env.FAKE_CLAUDE_REPLY)
  return defaultReply(readText())
}

function chooseReply() {
  const invalid = process.env.FAKE_CLAUDE_INVALID_REPLY ? JSON.parse(process.env.FAKE_CLAUDE_INVALID_REPLY) : INVALID
  if (structuredMode === 'invalid-twice') return invalid
  if (structuredMode === 'invalid-then-valid' && !prompt.startsWith('Your reply did not pass validation')) return invalid
  const decisionId = prompt.match(/Owner decided (d_[0-9a-f]{8})/)?.[1] ?? ''
  return JSON.parse(JSON.stringify(scriptedReply()).replaceAll('$DECISION_ID', decisionId))
}

const streamEvent = (event) => emit({ type: 'stream_event', event, session_id: id })

if (mode === 'hang') {
  setInterval(() => undefined, 1000)
} else if (structured) {
  const reply = chooseReply()
  const json = JSON.stringify(reply)
  streamEvent({ type: 'message_start', message: { id: 'msg_1' } })
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the change.' } })
  streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } })
  streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"features/x.feature","answer":"not this"}' } })
  streamEvent({ type: 'message_start', message: { id: 'msg_2' } })
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Composing the reply.' } })
  streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'StructuredOutput', input: {} } })
  for (const chunk of json.match(/[\s\S]{1,17}/g) ?? []) {
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: chunk } })
  }
  const failed = mode === 'fail'
  emit({
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    num_turns: 2,
    result: failed ? 'boom' : json,
    ...(failed || process.env.FAKE_CLAUDE_OMIT_STRUCTURED ? {} : { structured_output: reply }),
    session_id: id,
  })
  process.exit(failed ? 1 : 0)
} else {
  const text = readText()
  for (const chunk of text.match(/[\s\S]{1,40}/g) ?? []) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }, session_id: id })
  }
  const failed = mode === 'fail'
  emit({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, num_turns: 1, result: failed ? 'boom' : text, session_id: id })
  process.exit(failed ? 1 : 0)
}
