import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StructuredStream } from './answer-reader.ts'
import { parseJsonObject } from './protocol.ts'

export interface CodexRunSpec {
  bin: string
  cwd: string
  sessionId: string
  resume: boolean
  model: string
  // Desk capabilities, translated to scoped MCP tools rather than CLI tool-name allowlists.
  allowedTools: readonly string[]
  disallowedTools: readonly string[]
  permissionMode: 'default' | 'acceptEdits'
  appendSystemPrompt: string | null
  prompt: string
  jsonSchema?: string | null
  schemaFile?: string
  toolsScript?: string
  writeRoot?: string
  search?: boolean
  readDomains?: readonly string[]
}

export type ResultEvent = { type: 'result'; ok: boolean; text: string; numTurns: number; sessionId: string; structured?: unknown }
export type CodexEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'message_start' }
  | { type: 'tool_start'; index: number; name: string }
  | { type: 'json_delta'; index: number; json: string }
  | { type: 'answer_delta'; text: string }
  | { type: 'answer_reset' }
  | ResultEvent
export interface CodexOutcome {
  ok: boolean; text: string; sessionId: string; numTurns: number
  error: string | null; timedOut: boolean; structured: unknown
}

// JSON strings and arrays are also TOML values. Objects need TOML inline-table syntax.
export function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export const TOOLS_SCRIPT = fileURLToPath(new URL('./desk-tools.mjs', import.meta.url))
export function codexArgs(spec: CodexRunSpec): string[] {
  const write = spec.permissionMode === 'acceptEdits'
  const denied = spec.disallowedTools.flatMap((t) => /^Bash\((.+):\*\)$/.exec(t)?.[1] ?? [])
  const commands = spec.allowedTools.flatMap((t) => /^Bash\((.+):\*\)$/.exec(t)?.[1] ?? []).filter((command) => !denied.some((prefix) => command === prefix || command.startsWith(prefix + ' ')))
  const desk = {
    command: 'node',
    args: [spec.toolsScript ?? TOOLS_SCRIPT, JSON.stringify({ root: spec.cwd, writeRoot: write ? (spec.writeRoot ?? spec.cwd) : null, commands, deniedCommands: denied, search: spec.search === true, readDomains: spec.readDomains ?? [] })],
    required: true,
    tool_timeout_sec: 180,
  }
  return [
    'exec',
    '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--model', spec.model,
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
    '-c', 'features.multi_agent=false', '-c', 'features.view_image=false', '-c', 'features.goals=false', '-c', 'features.plugins=false', '-c', 'features.apps=false',
    '-c', 'web_search="disabled"',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', `mcp_servers=${toml({ desk })}`,
    '-c', `developer_instructions=${toml('Use the desk MCP tools for file access and permitted commands. Native shell tools are disabled. Do not use apply_patch; use desk.write_file when available.\n' + (spec.appendSystemPrompt ?? ''))}`,
    ...(spec.jsonSchema ? ['--output-schema', spec.schemaFile ?? path.join(spec.cwd, '.spec-review', 'reply-schema.json')] : []),
    ...(spec.resume ? ['resume', spec.sessionId, '-'] : ['-']),
  ]
}
export function prepareCodex(spec: CodexRunSpec): { spec: CodexRunSpec; dispose: () => void } {
  if (!spec.jsonSchema || spec.schemaFile) return { spec, dispose: () => undefined }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spec-review-schema-'))
  const schemaFile = path.join(dir, 'reply.json')
  writeFileSync(schemaFile, spec.jsonSchema, { mode: 0o600 })
  return { spec: { ...spec, schemaFile }, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

// Legacy Claude log decoding remains for runs persisted before the migration.
interface StreamInner {
  type?: string
  index?: unknown
  delta?: { type?: string; text?: unknown; partial_json?: unknown }
  content_block?: { type?: string; name?: unknown }
}

function parseStreamEvent(inner: StreamInner | undefined): CodexEvent | null {
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

export function parseStreamLine(line: string): CodexEvent | null {
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


// Codex JSONL is stateful: thread.started supplies the ID, agent_message holds the final
// text, and turn.completed supplies usage only. Never treat a message as a successful turn.
export class CodexStream {
  #session = ''
  #text = ''
  #turns = 0
  #index = 0
  feed(line: string): CodexEvent[] {
    let event: Record<string, any>
    try { event = JSON.parse(line) } catch { return [] }
    if (event.type === 'thread.started') {
      this.#session = event.thread_id
      return [{ type: 'init', sessionId: this.#session }]
    }
    if (event.type === 'item.started' && event.item?.type !== 'agent_message') {
      return [{ type: 'tool_start', index: this.#index++, name: event.item?.tool ?? event.item?.type ?? 'tool' }]
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      this.#text = typeof event.item.text === 'string' ? event.item.text : ''
      // The final JSON reply is an assistant message, not an internal tool call.
      if (this.#text.trimStart().startsWith('{')) return [
        { type: 'message_start' }, { type: 'tool_start', index: 0, name: 'StructuredOutput' },
        { type: 'json_delta', index: 0, json: this.#text },
      ]
      return [{ type: 'delta', text: this.#text }]
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      this.#turns += 1
      const ok = event.type === 'turn.completed'
      const text = ok ? this.#text : (event.error?.message ?? 'Codex turn failed')
      return [{ type: 'result', ok, text, numTurns: this.#turns, sessionId: this.#session, ...(ok ? { structured: parseJsonObject(text) } : {}) }]
    }
    if (event.type === 'error') return [{ type: 'result', ok: false, text: event.message ?? 'Codex error', numTurns: 0, sessionId: this.#session }]
    const old = parseStreamLine(line)
    return old ? [old] : []
  }
}
export function runCodex(spec: CodexRunSpec, opts: { timeoutMs: number; onEvent?: (e: CodexEvent) => void }): Promise<CodexOutcome> {
  return new Promise((resolve) => {
    const prepared = prepareCodex(spec)
    const child = spawn(spec.bin, codexArgs(prepared.spec), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const structuredStream = new StructuredStream()
    const stream = new CodexStream()
    let buffer = ''
    let stderr = ''
    let streamed = ''
    let result = null as ResultEvent | null
    let timedOut = false
    let settled = false
    const finish = (outcome: CodexOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      prepared.dispose()
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, opts.timeoutMs)
    const handle = (line: string): void => {
      for (const event of stream.feed(line)) {
        if (event.type === 'result') result = event
        if (event.type === 'delta') streamed += event.text
        opts.onEvent?.(event)
        for (const derived of structuredStream.feed(event)) opts.onEvent?.(derived)
      }
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
          : stderr.trim() || result?.text || `codex exited with code ${code}`
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

export const isMissingSession = (outcome: CodexOutcome): boolean =>
  !outcome.ok && !outcome.timedOut && /No conversation found|no (?:saved )?(?:session|rollout|thread) found|session .* not found/i.test(outcome.error ?? '')
