import { spawn } from 'node:child_process'
import { StructuredStream } from './answer-reader.ts'
import { parseJsonObject } from './protocol.ts'

export interface ClaudeRunSpec {
  bin: string
  cwd: string
  sessionId: string
  resume: boolean
  model: string
  allowedTools: readonly string[]
  disallowedTools: readonly string[]
  permissionMode: 'default' | 'acceptEdits'
  appendSystemPrompt: string | null
  prompt: string
  // JSON Schema of the final reply. With it the CLI answers through its internal StructuredOutput
  // tool, and the result event carries `structured_output` (spike 2026-09-24).
  jsonSchema?: string | null
}

export type ResultEvent = { type: 'result'; ok: boolean; text: string; numTurns: number; sessionId: string; structured?: unknown }
export type ClaudeEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'message_start' }
  | { type: 'tool_start'; index: number; name: string }
  | { type: 'json_delta'; index: number; json: string }
  | { type: 'answer_delta'; text: string }
  | { type: 'answer_reset' }
  | ResultEvent

export interface ClaudeOutcome {
  ok: boolean
  text: string
  sessionId: string
  numTurns: number
  error: string | null
  timedOut: boolean
  structured: unknown
}

interface StreamInner {
  type?: string
  index?: unknown
  delta?: { type?: string; text?: unknown; partial_json?: unknown }
  content_block?: { type?: string; name?: unknown }
}

export function claudeArgs(spec: ClaudeRunSpec): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // No MCP servers, ever: the owner's user/project MCP config never reaches a spawned agent.
    '--strict-mcp-config',
    '--model', spec.model,
    ...(spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]),
    '--permission-mode', spec.permissionMode,
    `--allowedTools=${spec.allowedTools.join(',')}`,
    ...(spec.disallowedTools.length ? [`--disallowedTools=${spec.disallowedTools.join(',')}`] : []),
    ...(spec.appendSystemPrompt ? ['--append-system-prompt', spec.appendSystemPrompt] : []),
    ...(spec.jsonSchema ? ['--json-schema', spec.jsonSchema] : []),
  ]
}

function parseStreamEvent(inner: StreamInner | undefined): ClaudeEvent | null {
  const index = typeof inner?.index === 'number' ? inner.index : 0
  if (inner?.type === 'message_start') return { type: 'message_start' }
  if (inner?.type === 'content_block_start' && inner.content_block?.type === 'tool_use' && typeof inner.content_block.name === 'string') {
    return { type: 'tool_start', index, name: inner.content_block.name }
  }
  if (inner?.type !== 'content_block_delta') return null
  if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') return { type: 'delta', text: inner.delta.text }
  if (inner.delta?.type === 'input_json_delta' && typeof inner.delta.partial_json === 'string') {
    return { type: 'json_delta', index, json: inner.delta.partial_json }
  }
  return null
}

export function parseStreamLine(line: string): ClaudeEvent | null {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    return { type: 'init', sessionId: event.session_id }
  }
  if (event.type === 'stream_event') return parseStreamEvent(event.event as StreamInner | undefined)
  if (event.type === 'result') {
    return {
      type: 'result',
      ok: event.is_error !== true && event.subtype === 'success',
      text: typeof event.result === 'string' ? event.result : '',
      numTurns: typeof event.num_turns === 'number' ? event.num_turns : 0,
      sessionId: typeof event.session_id === 'string' ? event.session_id : '',
      ...(event.structured_output !== undefined ? { structured: event.structured_output } : {}),
    }
  }
  return null
}

export function runClaude(spec: ClaudeRunSpec, opts: { timeoutMs: number; onEvent?: (e: ClaudeEvent) => void }): Promise<ClaudeOutcome> {
  return new Promise((resolve) => {
    const child = spawn(spec.bin, claudeArgs(spec), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const structuredStream = new StructuredStream()
    let buffer = ''
    let stderr = ''
    let streamed = ''
    let result = null as ResultEvent | null
    let timedOut = false
    let settled = false
    const finish = (outcome: ClaudeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, opts.timeoutMs)
    const handle = (line: string): void => {
      const event = parseStreamLine(line)
      if (!event) return
      if (event.type === 'result') result = event
      if (event.type === 'delta') streamed += event.text
      opts.onEvent?.(event)
      for (const derived of structuredStream.feed(event)) opts.onEvent?.(derived)
    }
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        handle(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (error) => {
      finish({ ok: false, text: '', sessionId: spec.sessionId, numTurns: 0, error: error.message, timedOut: false, structured: null })
    })
    child.on('close', (code) => {
      if (buffer.trim()) handle(buffer)
      const ok = !timedOut && code === 0 && result?.ok === true
      const error = ok
        ? null
        : timedOut
          ? `timed out after ${Math.max(1, Math.round(opts.timeoutMs / 60_000))} min`
          : stderr.trim() || result?.text || `claude exited with code ${code}`
      const structured = result?.structured ?? (spec.jsonSchema && result ? parseJsonObject(result.text) : null)
      finish({
        ok,
        text: result?.text || streamed,
        sessionId: result?.sessionId || spec.sessionId,
        numTurns: result?.numTurns ?? 0,
        error,
        timedOut,
        structured: ok ? structured : null,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(spec.prompt)
  })
}

export const isMissingSession = (outcome: ClaudeOutcome): boolean =>
  !outcome.ok && !outcome.timedOut && outcome.numTurns === 0 && (outcome.error?.includes('No conversation found') ?? false)
