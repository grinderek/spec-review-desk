// Exercises the real Codex CLI against a local Responses fixture, without a paid model call.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { codexArgs, CodexStream, prepareCodex } from '../server/codex.ts'
import { AGENT_REPLY_SCHEMA_ARG } from '../server/protocol.ts'

const tmp = await mkdtemp(path.join(os.tmpdir(), 'sr-real-codex-'))
await mkdir(path.join(tmp, 'workspace'))
await mkdir(path.join(tmp, 'codex-home'))
await writeFile(path.join(tmp, 'workspace', 'brief.md'), 'Approved fixture.')
let requests = 0
let toolName = ''
let usedTools = false
let nativeBypass = false
const reply = { answer: 'Codex adapter works', patch: null, decisions: [], resolves: [], status: 'answered' }
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  requests++
  const tools = body.tools ?? []
  nativeBypass ||= tools.some((tool: { name?: string }) => ['view_image', 'shell', 'exec_command', 'write_stdin'].includes(tool.name ?? ''))

  const namespace = tools.find((t: { name?: string }) => t.name === 'mcp__desk')
  toolName = namespace?.tools?.find((t: { name: string }) => t.name === 'list_files')?.name ?? tools.find((t: { name?: string }) => t.name?.includes('desk') && t.name?.includes('list_files'))?.name ?? toolName
  const didTool = (body.input ?? []).some((item: { type: string }) => item.type === 'function_call_output')
  usedTools ||= didTool && JSON.stringify(body.input).includes('brief.md')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const result = { id: `resp_${requests}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', output: [] as object[], model: 'gpt-5.4', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  emit('response.created', { response: result })
  if (toolName && !didTool && requests === 1) {
    const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: toolName, ...(namespace ? { namespace: 'mcp__desk' } : {}), arguments: '{}' }
    emit('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
    emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: '{}' })
    emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: '{}' })
    emit('response.output_item.done', { output_index: 0, item })
    result.output.push(item)
  } else {
    const text = JSON.stringify(reply)
    const item = { id: `msg_${requests}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
    emit('response.output_item.done', { output_index: 0, item })
    result.output.push(item)
  }
  emit('response.completed', { response: { ...result, status: 'completed' } })
  response.end()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
async function exec(resume: boolean, sessionId = '') {
  const prepared = prepareCodex({ bin: 'codex', cwd: path.join(tmp, 'workspace'), sessionId, resume, model: 'gpt-5.4', allowedTools: ['Read'], disallowedTools: [], permissionMode: 'default', appendSystemPrompt: null, prompt: 'Read brief.md and return the requested JSON.', jsonSchema: AGENT_REPLY_SCHEMA_ARG })
  const args = codexArgs(prepared.spec)
  args.splice(args.length - (resume ? 3 : 1), 0, '-c', 'model_provider="desk_fixture"', '-c', `model_providers.desk_fixture={name="Desk fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`)
  let stdout = ''; let stderr = ''
  const child = spawn(process.env.SPEC_REVIEW_CODEX_BIN ?? 'codex', args, { cwd: prepared.spec.cwd, env: { ...process.env, CODEX_HOME: path.join(tmp, 'codex-home') }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdin.end(prepared.spec.prompt)
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  clearTimeout(timer); prepared.dispose()
  assert.equal(code, 0, stderr)
  const stream = new CodexStream()
  const events = stdout.split('\n').flatMap((line) => stream.feed(line))
  const result = events.findLast((e) => e.type === 'result')
  assert.ok(result?.type === 'result' && result.ok, stdout)
  assert.deepEqual(result.structured, reply)
  return result.sessionId
}
try {
  const session = await exec(false)
  assert.match(session, /^[0-9a-f-]{36}$/)
  assert.equal(nativeBypass, false, 'Codex exposed an unscoped native file/shell tool')
  assert.ok(toolName, 'Codex did not expose the scoped Desk MCP tools')
  assert.ok(usedTools, 'Codex did not execute the MCP call')
  const resumed = await exec(true, session)
  // Some Codex versions omit thread.started on resume; result parsing must still succeed.
  if (resumed) assert.equal(resumed, session)
  console.log('Real Codex CLI: scoped MCP call, JSON Schema reply and session resume passed (local model fixture).')
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(tmp, { recursive: true, force: true })
}
