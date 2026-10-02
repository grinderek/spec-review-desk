#!/usr/bin/env node
// Test double for Codex exec: native thread/item/turn JSONL, driven by FAKE_CODEX_* variables.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
if (args.includes('--version')) {
  process.stdout.write('fake-codex 0.0.0\n')
  process.exit(0)
}
const prompt = readFileSync(0, 'utf8')
const sessions = process.env.FAKE_CODEX_SESSIONS ?? path.join(process.cwd(), '.fake-codex-sessions')
mkdirSync(sessions, { recursive: true })
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, prompt, cwd: process.cwd() })}\n`)
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

const resume = flag('resume')
const id = resume ?? randomUUID()
if (resume && !existsSync(path.join(sessions, resume))) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`)
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, result: '', session_id: resume })
  process.exit(1)
}
writeFileSync(path.join(sessions, id), 'known')
emit({ type: 'thread.started', thread_id: id })

const mode = process.env.FAKE_CODEX_MODE ?? 'answer'
const structuredMode = process.env.FAKE_CODEX_STRUCTURED ?? 'valid'
const structured = args.includes('--output-schema') && structuredMode !== 'off'
const readText = () =>
  process.env.FAKE_CODEX_TEXT_FILE ? readFileSync(process.env.FAKE_CODEX_TEXT_FILE, 'utf8') : (process.env.FAKE_CODEX_TEXT ?? 'pong')
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
    status: args.some((arg) => arg.includes('git add')) ? 'done' : 'answered',
  }
}

const scriptedHit = () =>
  process.env.FAKE_CODEX_REPLIES_FILE
    ? JSON.parse(readFileSync(process.env.FAKE_CODEX_REPLIES_FILE, 'utf8')).find((entry) => prompt.includes(entry.match))
    : undefined

function scriptedReply() {
  const hit = scriptedHit()
  if (hit) return hit.reply
  if (process.env.FAKE_CODEX_REPLY_FILE) return JSON.parse(readFileSync(process.env.FAKE_CODEX_REPLY_FILE, 'utf8'))
  if (process.env.FAKE_CODEX_REPLY) return JSON.parse(process.env.FAKE_CODEX_REPLY)
  return defaultReply(readText())
}

function chooseReply() {
  const invalid = process.env.FAKE_CODEX_INVALID_REPLY ? JSON.parse(process.env.FAKE_CODEX_INVALID_REPLY) : INVALID
  if (structuredMode === 'invalid-twice') return invalid
  if (structuredMode === 'invalid-then-valid' && !prompt.startsWith('Your reply did not pass validation')) return invalid
  const decisionId = prompt.match(/Owner decided (d_[0-9a-f]{8})/)?.[1] ?? ''
  return JSON.parse(JSON.stringify(scriptedReply()).replaceAll('$DECISION_ID', decisionId))
}

// Spec B: the sandboxed author writes files. FAKE_CODEX_WRITES_FILE is a JSON array of
// {match, files}; sandbox runs write under FAKE_CODEX_OUT, host Apply under its fixture cwd.
if (process.env.FAKE_CODEX_WRITES_FILE) {
  const hit = JSON.parse(readFileSync(process.env.FAKE_CODEX_WRITES_FILE, 'utf8')).find((entry) => prompt.includes(entry.match))
  for (const [rel, body] of Object.entries(hit?.files ?? {})) {
    const file = path.join(process.env.FAKE_CODEX_OUT ?? process.cwd(), rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
}

const streamEvent = (event) => emit({ type: 'stream_event', event, session_id: id })

// FAKE_CODEX_HANG_MATCH: like FAKE_CODEX_MODE=hang, but scoped to prompts containing this text,
// and only the FIRST such invocation — tracked via FAKE_CODEX_HANG_COUNT_FILE, a marker file this
// process creates on its first hang. This lets an e2e fixture simulate one run hanging (so the UI's
// Stop control can be exercised), then retry the same action and let it finish normally, without a
// second global FAKE_CODEX_MODE flip (the e2e server is one long-lived process shared by every run).
const hangMatch = process.env.FAKE_CODEX_HANG_MATCH
const hangCountFile = process.env.FAKE_CODEX_HANG_COUNT_FILE
const hangOnce = Boolean(hangMatch) && prompt.includes(hangMatch) && hangCountFile !== undefined && !existsSync(hangCountFile)
if (hangOnce) writeFileSync(hangCountFile, 'hung once')

if (mode === 'hang' || hangOnce) {
  setInterval(() => undefined, 1000)
} else if (structured) {
  const reply = chooseReply()
  emit({ type: 'item.completed', item: { id: 'narration', type: 'agent_message', text: 'Reading the change.' } })
  const delayMs = scriptedHit()?.delayMs ?? 0
  for (const end = Date.now() + delayMs; Date.now() < end; ) {
    emit({ type: 'item.completed', item: { id: 'progress', type: 'agent_message', text: ' Working through the room.'.repeat(12) } })
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const failed = mode === 'fail'
  emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify(reply) } })
  emit(failed ? { type: 'turn.failed', error: { message: 'boom' } } : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(failed ? 1 : 0)
} else {
  const failed = mode === 'fail'
  emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: readText() } })
  emit(failed ? { type: 'turn.failed', error: { message: 'boom' } } : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(failed ? 1 : 0)
}
