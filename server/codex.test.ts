import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { codexArgs, CodexStream, type CodexEvent, type CodexRunSpec, isMissingSession, parseStreamLine, runCodex } from './codex.ts'
import { run } from './git.ts'
import { AGENT_REPLY_SCHEMA_ARG } from './protocol.ts'
import { FAKE_CODEX, resetFakeCodex } from './testing/fake-codex-path.ts'

let log = ''
const spec = (over: Partial<CodexRunSpec> = {}): CodexRunSpec => ({
  bin: FAKE_CODEX, cwd: os.tmpdir(), sessionId: '11111111-1111-4111-8111-111111111111', resume: false, model: 'gpt-5.4',
  allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'], permissionMode: 'default', appendSystemPrompt: 'Rules.', prompt: 'Question?', ...over,
})

beforeEach(async () => {
  resetFakeCodex()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sr-claude-'))
  log = path.join(dir, 'log.ndjson')
  process.env.FAKE_CODEX_SESSIONS = path.join(dir, 'sessions')
  process.env.FAKE_CODEX_LOG = log
  process.env.FAKE_CODEX_MODE = 'answer'
  process.env.FAKE_CODEX_TEXT = 'The answer is 42, because the formula says so.'
})

describe('codexArgs', () => {
  it('uses exec JSONL and never passes the prompt as an argument', () => {
    const args = codexArgs(spec())
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--model', 'gpt-5.4', '--ignore-user-config', '--ignore-rules', 'approval_policy="never"', 'sandbox_mode="read-only"', 'features.shell_tool=false', 'web_search="disabled"']))
    expect(args).not.toContain('Question?')
    expect(codexArgs(spec({ resume: true })).slice(-3)).toEqual(['resume', spec().sessionId, '-'])
  })
  it('exposes the Desk MCP server with scoped capabilities in either permission mode', () => {
    for (const permissionMode of ['default', 'acceptEdits'] as const) {
      const args = codexArgs(spec({ permissionMode }))
      expect(args.some((arg) => arg.startsWith('mcp_servers=') && arg.includes('desk-tools.mjs'))).toBe(true)
      expect(args).not.toContain('--allowedTools')
    }
  })
})

describe('fake-codex --version', () => {
  it('answers a bare --version without reading stdin, like the capability probe expects', async () => {
    const result = await run(FAKE_CODEX, ['--version'], { cwd: os.tmpdir(), timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('fake-codex 0.0.0')
  })
})

describe('parseStreamLine', () => {
  it('reads init, text deltas and the result, and ignores everything else', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s"}')).toEqual({ type: 'init', sessionId: 's' })
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}')).toEqual({ type: 'delta', text: 'hi' })
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta"}}}')).toBeNull()
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done","session_id":"s"}'))
      .toEqual({ type: 'result', ok: true, text: 'done', numTurns: 2, sessionId: 's' })
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine('{"type":"rate_limit_event"}')).toBeNull()
  })
})

describe('runCodex', () => {
  it('streams deltas, returns the result and sends the prompt on stdin', async () => {
    const events: CodexEvent[] = []
    const outcome = await runCodex(spec(), { timeoutMs: 10_000, onEvent: (e) => events.push(e) })
    expect(outcome).toMatchObject({ ok: true, text: 'The answer is 42, because the formula says so.', numTurns: 1, error: null, timedOut: false })
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe(outcome.text)
    const call = JSON.parse((await readFile(log, 'utf8')).trim()) as { prompt: string }
    expect(call.prompt).toBe('Question?')
  })

  it('detects a missing session on resume', async () => {
    const outcome = await runCodex(spec({ resume: true, sessionId: '22222222-2222-4222-8222-222222222222' }), { timeoutMs: 10_000 })
    expect(outcome.ok).toBe(false)
    expect(isMissingSession(outcome)).toBe(true)
    expect(outcome.error).toMatch(/No conversation found/)
  })

  it('reports a failure and a timeout without throwing', async () => {
    process.env.FAKE_CODEX_MODE = 'fail'
    const failed = await runCodex(spec(), { timeoutMs: 10_000 })
    expect(failed).toMatchObject({ ok: false, timedOut: false })
    expect(isMissingSession(failed)).toBe(false)
    process.env.FAKE_CODEX_MODE = 'hang'
    const hung = await runCodex(spec(), { timeoutMs: 300 })
    expect(hung).toMatchObject({ ok: false, timedOut: true, error: expect.stringMatching(/timed out/) })
  })

  it('reports a missing binary as a hard failure, not a missing session to retry fresh', async () => {
    const outcome = await runCodex(spec({ bin: '/nonexistent/claude' }), { timeoutMs: 1000 })
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/ENOENT/) })
    expect(isMissingSession(outcome)).toBe(false)
  })
})

describe('structured replies (--output-schema)', () => {
  const reply = { answer: 'Partial days count.\n"Quoted" ü 😀', patch: null, decisions: [], resolves: [], status: 'answered' }

  it('passes the schema file as --output-schema only when asked', () => {
    const args = codexArgs(spec({ jsonSchema: AGENT_REPLY_SCHEMA_ARG }))
    expect(args[args.indexOf('--output-schema') + 1]).toMatch(/reply-schema\.json$/)
    expect(codexArgs(spec())).not.toContain('--output-schema')
  })

  it('reads message starts, tool starts, json deltas and structured_output', () => {
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"message_start","message":{}}}')).toEqual({ type: 'message_start' })
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"StructuredOutput","input":{}}}}'))
      .toEqual({ type: 'tool_start', index: 1, name: 'StructuredOutput' })
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"an"}}}'))
      .toEqual({ type: 'json_delta', index: 1, json: '{"an' })
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"{}","structured_output":{"a":1},"session_id":"s"}'))
      .toEqual({ type: 'result', ok: true, text: '{}', numTurns: 2, sessionId: 's', structured: { a: 1 } })
  })

  it('streams only the answer of a multi-turn reply and returns the structured object', async () => {
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply)
    const events: CodexEvent[] = []
    const outcome = await runCodex(spec({ jsonSchema: AGENT_REPLY_SCHEMA_ARG }), { timeoutMs: 10_000, onEvent: (e) => events.push(e) })
    expect(outcome).toMatchObject({ ok: true, structured: reply, text: JSON.stringify(reply), numTurns: 1 })
    expect(events.flatMap((e) => (e.type === 'answer_delta' ? [e.text] : [])).join('')).toBe(reply.answer)
    expect(events.some((e) => e.type === 'delta' && e.text === 'Reading the change.')).toBe(true)
  })

  it('falls back to parsing the result text when structured_output is absent', async () => {
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply)
    process.env.FAKE_CODEX_OMIT_STRUCTURED = '1'
    const outcome = await runCodex(spec({ jsonSchema: AGENT_REPLY_SCHEMA_ARG }), { timeoutMs: 10_000 })
    expect(outcome.structured).toEqual(reply)
  })

  it('keeps structured null for a plain run', async () => {
    expect((await runCodex(spec(), { timeoutMs: 10_000 })).structured).toBeNull()
  })

  it('fake: invalid-then-valid answers only the validation retry with the valid reply', async () => {
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply)
    process.env.FAKE_CODEX_STRUCTURED = 'invalid-then-valid'
    const first = await runCodex(spec({ jsonSchema: AGENT_REPLY_SCHEMA_ARG }), { timeoutMs: 10_000 })
    expect((first.structured as { decisions: { recommended: string }[] }).decisions[0]!.recommended).toBe('sqlite')
    const retry = await runCodex(
      spec({ jsonSchema: AGENT_REPLY_SCHEMA_ARG, prompt: 'Your reply did not pass validation: x. Reply again with the same schema.' }),
      { timeoutMs: 10_000 },
    )
    expect(retry.structured).toEqual(reply)
  })
})

describe('native Codex JSONL', () => {
  it('joins thread ID, final assistant JSON and turn completion, without finishing on narration', () => {
    const stream = new CodexStream()
    expect(stream.feed(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }))).toEqual([{ type: 'init', sessionId: 'codex-session' }])
    const narration = stream.feed(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reading files.' } }))
    expect(narration).toEqual([{ type: 'delta', text: 'Reading files.' }])
    const reply = { answer: 'Ready.', patch: null, decisions: [], resolves: [], status: 'answered' }
    expect(stream.feed(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } })).some((e) => e.type === 'result')).toBe(false)
    expect(stream.feed(JSON.stringify({ type: 'turn.completed', usage: {} }))).toEqual([{ type: 'result', ok: true, text: JSON.stringify(reply), structured: reply, numTurns: 1, sessionId: 'codex-session' }])
  })
  it('reports a failed turn even when an assistant message preceded it', () => {
    const stream = new CodexStream()
    stream.feed(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"not final"}' } }))
    expect(stream.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'Connection failed' } }))).toEqual([{ type: 'result', ok: false, text: 'Connection failed', numTurns: 1, sessionId: '' }])
  })
})
