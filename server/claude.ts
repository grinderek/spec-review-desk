import { spawn } from 'node:child_process'

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
}

export type ResultEvent = { type: 'result'; ok: boolean; text: string; numTurns: number; sessionId: string }
export type ClaudeEvent = { type: 'init'; sessionId: string } | { type: 'delta'; text: string } | ResultEvent

export interface ClaudeOutcome {
  ok: boolean
  text: string
  sessionId: string
  numTurns: number
  error: string | null
  timedOut: boolean
}

export function claudeArgs(spec: ClaudeRunSpec): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', spec.model,
    ...(spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]),
    '--permission-mode', spec.permissionMode,
    `--allowedTools=${spec.allowedTools.join(',')}`,
    ...(spec.disallowedTools.length ? [`--disallowedTools=${spec.disallowedTools.join(',')}`] : []),
    ...(spec.appendSystemPrompt ? ['--append-system-prompt', spec.appendSystemPrompt] : []),
  ]
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
  if (event.type === 'stream_event') {
    const inner = event.event as { type?: string; delta?: { type?: string; text?: unknown } } | undefined
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
      return { type: 'delta', text: inner.delta.text }
    }
    return null
  }
  if (event.type === 'result') {
    return {
      type: 'result',
      ok: event.is_error !== true && event.subtype === 'success',
      text: typeof event.result === 'string' ? event.result : '',
      numTurns: typeof event.num_turns === 'number' ? event.num_turns : 0,
      sessionId: typeof event.session_id === 'string' ? event.session_id : '',
    }
  }
  return null
}

export function runClaude(spec: ClaudeRunSpec, opts: { timeoutMs: number; onEvent?: (e: ClaudeEvent) => void }): Promise<ClaudeOutcome> {
  return new Promise((resolve) => {
    const child = spawn(spec.bin, claudeArgs(spec), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
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
      finish({ ok: false, text: '', sessionId: spec.sessionId, numTurns: 0, error: error.message, timedOut: false })
    })
    child.on('close', (code) => {
      if (buffer.trim()) handle(buffer)
      const ok = !timedOut && code === 0 && result?.ok === true
      const error = ok
        ? null
        : timedOut
          ? `timed out after ${Math.max(1, Math.round(opts.timeoutMs / 60_000))} min`
          : stderr.trim() || result?.text || `claude exited with code ${code}`
      finish({ ok, text: result?.text || streamed, sessionId: result?.sessionId || spec.sessionId, numTurns: result?.numTurns ?? 0, error, timedOut })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(spec.prompt)
  })
}

export const isMissingSession = (outcome: ClaudeOutcome): boolean => !outcome.ok && !outcome.timedOut && outcome.numTurns === 0
