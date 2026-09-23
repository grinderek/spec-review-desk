import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { claudeArgs, type ClaudeEvent, type ClaudeRunSpec, isMissingSession, parseStreamLine, runClaude } from './claude.ts'
import { run } from './git.ts'
import { FAKE_CLAUDE } from './testing/fake-claude-path.ts'

let log = ''
const spec = (over: Partial<ClaudeRunSpec> = {}): ClaudeRunSpec => ({
  bin: FAKE_CLAUDE, cwd: os.tmpdir(), sessionId: '11111111-1111-4111-8111-111111111111', resume: false, model: 'opus',
  allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'], permissionMode: 'default', appendSystemPrompt: 'Rules.', prompt: 'Question?', ...over,
})

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sr-claude-'))
  log = path.join(dir, 'log.ndjson')
  process.env.FAKE_CLAUDE_SESSIONS = path.join(dir, 'sessions')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.FAKE_CLAUDE_MODE = 'answer'
  process.env.FAKE_CLAUDE_TEXT = 'The answer is 42, because the formula says so.'
})

describe('claudeArgs', () => {
  it('uses the = form for tool lists and never passes the prompt as an argument', () => {
    const args = claudeArgs(spec())
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'opus', '--session-id', '--permission-mode', 'default', '--allowedTools=Read,Grep', '--disallowedTools=Bash', '--append-system-prompt', 'Rules.']))
    expect(args).not.toContain('Question?')
    expect(claudeArgs(spec({ resume: true }))).toContain('--resume')
  })

  it('always spawns with no MCP servers, regardless of permission mode', () => {
    expect(claudeArgs(spec())).toContain('--strict-mcp-config')
    expect(claudeArgs(spec({ permissionMode: 'acceptEdits' }))).toContain('--strict-mcp-config')
  })
})

describe('fake-claude --version', () => {
  it('answers a bare --version without reading stdin, like the capability probe expects', async () => {
    const result = await run(FAKE_CLAUDE, ['--version'], { cwd: os.tmpdir(), timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('fake-claude 0.0.0')
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

describe('runClaude', () => {
  it('streams deltas, returns the result and sends the prompt on stdin', async () => {
    const events: ClaudeEvent[] = []
    const outcome = await runClaude(spec(), { timeoutMs: 10_000, onEvent: (e) => events.push(e) })
    expect(outcome).toMatchObject({ ok: true, text: 'The answer is 42, because the formula says so.', numTurns: 1, error: null, timedOut: false })
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe(outcome.text)
    const call = JSON.parse((await readFile(log, 'utf8')).trim()) as { prompt: string }
    expect(call.prompt).toBe('Question?')
  })

  it('detects a missing session on resume', async () => {
    const outcome = await runClaude(spec({ resume: true, sessionId: '22222222-2222-4222-8222-222222222222' }), { timeoutMs: 10_000 })
    expect(outcome.ok).toBe(false)
    expect(isMissingSession(outcome)).toBe(true)
    expect(outcome.error).toMatch(/No conversation found/)
  })

  it('reports a failure and a timeout without throwing', async () => {
    process.env.FAKE_CLAUDE_MODE = 'fail'
    const failed = await runClaude(spec(), { timeoutMs: 10_000 })
    expect(failed).toMatchObject({ ok: false, timedOut: false })
    expect(isMissingSession(failed)).toBe(false)
    process.env.FAKE_CLAUDE_MODE = 'hang'
    const hung = await runClaude(spec(), { timeoutMs: 300 })
    expect(hung).toMatchObject({ ok: false, timedOut: true, error: expect.stringMatching(/timed out/) })
  })

  it('reports a missing binary as a hard failure, not a missing session to retry fresh', async () => {
    const outcome = await runClaude(spec({ bin: '/nonexistent/claude' }), { timeoutMs: 1000 })
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/ENOENT/) })
    expect(isMissingSession(outcome)).toBe(false)
  })
})
