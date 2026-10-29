#!/usr/bin/env node
// A small stdio MCP server. Codex has no shell; this process enforces the Desk's capabilities.
import { realpath, readdir, readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const MAX_FILE = 8 * 1024 * 1024
const EXCLUDED = new Set(['.git', '.codex', '.claude', '.spec-review', 'node_modules', '.env'])
const within = (root, file) => file === root || file.startsWith(root + path.sep)
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const tool = (name, description, inputSchema) => ({ name, description, inputSchema })

export function toolDefinitions(config) {
  return [
    tool('read_file', 'Read a UTF-8 file, PDF text or image inside a permitted component. Absolute paths are supported.', schema({ path: string }, ['path'])),
    tool('list_files', 'List files inside the permitted root, recursively. Secrets and internal directories are excluded.', schema({ path: string }, [])),
    tool('search_text', 'Find literal text inside readable UTF-8 files.', schema({ query: string, path: string }, ['query'])),
    ...(config.writeRoot ? [tool('write_file', 'Write a UTF-8 file inside the writable root only.', schema({ path: string, content: string }, ['path', 'content']))] : []),
    ...(config.commands?.length ? [tool('run_command', 'Run an allowed argv command, without a shell. Select a configured component by repository name; defaults to the change repository.', schema({ argv: { type: 'array', items: string, minItems: 1 }, repository: string }, ['argv']))] : []),
    ...(config.checks?.length ? [tool('run_check', 'Run an exact configured verification or environment command by name. Returns its exit status and output.', schema({ name: { type: 'string', enum: config.checks.map(c => c.name) } }, ['name']))] : []),
    ...(config.search ? [tool('search_web', 'Search the web. Returns search result titles, URLs and snippets; never opens result pages.', schema({ query: string }, ['query']))] : []),
    ...(config.readDomains?.length ? [tool('read_web_page', 'Read an HTTPS page on an owner-approved domain. Every redirect is checked.', schema({ url: string }, ['url']))] : []),
  ]
}

export function createTools(config) {
  const root = path.resolve(config.root)
  const writeRoot = config.writeRoot ? path.resolve(config.writeRoot) : null
  const workspaces = config.workspaceRoots ?? []
  const roots = [...new Set([root, ...(writeRoot ? [writeRoot] : []), ...workspaces.map(w => path.resolve(w.path))])]
  const writable = writeRoot ? [...new Set([writeRoot, ...workspaces.map(w => path.resolve(w.path))])] : []
  async function resolveFile(raw = '.', writing = false) {
    const file = path.resolve(writing ? writeRoot ?? root : root, raw)
    const base = (writing ? writable : roots).filter(r => within(r, file)).sort((a, b) => b.length - a.length)[0]
    if (!base || path.relative(base, file).split(path.sep).some((part) => EXCLUDED.has(part) || /^\.env(?:\.|$)/.test(part))) throw new Error('Path is outside the permitted files')
    if (writing && /(?:^|[/\\])(?:review\.yaml|review\.events\.jsonl|decisions\.md|initiative\.yaml|initiative\.events\.jsonl)$/.test(path.relative(base, file))) throw new Error('Desk owns this journal or projection; use its public commands')
    // Validate every existing ancestor, including a symlink in a yet-to-be-created write path.
    let ancestor = file
    for (;;) {
      try {
        const actual = await realpath(ancestor)
        const actualBase = await realpath(base)
        if (!within(actualBase, actual) || path.relative(actualBase, actual).split(path.sep).some(part => EXCLUDED.has(part) || /^\.env(?:\.|$)/.test(part))) throw new Error('Symlink escapes the permitted files')
        break
      } catch (error) {
        if (error.code !== 'ENOENT' || ancestor === base) throw error
        ancestor = path.dirname(ancestor)
      }
    }
    return file
  }
  async function files(raw = '.') {
    const start = await resolveFile(raw)
    const result = []
    async function walk(dir) {
      if (result.length >= 2000) return
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (EXCLUDED.has(item.name) || /^\.env(?:\.|$)/.test(item.name) || item.isSymbolicLink()) continue
        const file = path.join(dir, item.name)
        if (item.isDirectory()) await walk(file)
        else if (item.isFile()) result.push(file)
      }
    }
    const stat = await lstat(start)
    if (stat.isFile()) result.push(start)
    else await walk(start)
    return result
  }
  const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
  return async (name, args) => {
    if (!toolDefinitions(config).some((t) => t.name === name)) throw new Error('Tool is not permitted for this agent')
    if (name === 'list_files') return text((await files(args.path)).map((f) => path.relative(root, f)))
    if (name === 'read_file') {
      const file = await resolveFile(args.path)
      if ((await lstat(file)).size > MAX_FILE) throw new Error('File is too large')
      if (/\.pdf$/i.test(file)) return text(await command(['pdftotext', file, '-'], root, false))
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()]
      if (mime) return { content: [{ type: 'image', mimeType: mime, data: (await readFile(file)).toString('base64') }] }
      return text(await readFile(file, 'utf8'))
    }
    if (name === 'search_text') {
      if (typeof args.query !== 'string' || !args.query) throw new Error('A nonempty query is required')
      const hits = []
      for (const file of await files(args.path)) {
        if ((await lstat(file)).size > MAX_FILE) continue
        const body = await readFile(file, 'utf8')
        if (body.includes('\0')) continue
        for (const [i, line] of body.split('\n').entries()) {
          if (line.includes(args.query)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.slice(0, 1000)}`)
          if (hits.length >= 200) return text(hits)
        }
      }
      return text(hits)
    }
    if (name === 'write_file') {
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE) throw new Error('Invalid file content')
      const file = await resolveFile(args.path, true)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, args.content)
      return text('Written')
    }
    if (name === 'run_command') {
      const argv = args.argv
      if (!Array.isArray(argv) || !argv.length || argv.some((s) => typeof s !== 'string' || s.includes('\0'))) throw new Error('Invalid argv')
      const permitted = config.commands.some((prefix) => {
        const parts = prefix.split(/\s+/)
        return parts.every((part, i) => argv[i] === part)
      })
      const denied = (config.deniedCommands ?? []).some((prefix) => prefix.split(/\s+/).every((part, i) => argv[i] === part))
      if (!permitted || denied || argv.some((s) => /^(?:--(?:git-dir|work-tree|exec-path|output|config-env)|-C|-c)(?:=|$)/.test(s))) throw new Error('Command is outside the allowlist')
      const workspace = args.repository === undefined ? null : workspaces.find(w => w.name === args.repository)
      if (args.repository !== undefined && !workspace) throw new Error('Unknown repository name')
      const cwd = workspace?.path ?? root
      if (argv[0] === 'git' && workspace?.git === false) throw new Error('This component is a directory, not a Git checkout')
      if (argv[0] === 'git' && (argv.includes('--amend') || argv.includes('--no-index') || argv[1] === 'add' && argv.slice(2).some(arg => ['-A', '--all', '.', ':/'].includes(arg)))) throw new Error('Use explicit implementation paths and preserve Git history')
      // No shell expansion, aliases, hooks or inherited API credentials in child commands.
      const safe = argv[0] === 'git' ? ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv.slice(1)] : argv
      return text(await command(safe, cwd, true))
    }
    if (name === 'run_check') {
      const check = config.checks.find(c => c.name === args.name)
      if (!check || !roots.includes(path.resolve(check.cwd))) throw new Error('Unknown verification command or component')
      return text(await command(check.argv, check.cwd, true, check.timeoutMs))
    }
    if (name === 'search_web') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) throw new Error('Invalid search query')
      const url = new URL('https://www.bing.com/search')
      url.searchParams.set('format', 'rss'); url.searchParams.set('q', args.query)
      const xml = await fetchText(url)
      const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[e]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      const results = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => Object.fromEntries(['title', 'link', 'description'].map((key) => [key, decode(new RegExp(`<${key}>([\\s\\S]*?)<\\/${key}>`).exec(m[1])?.[1] ?? '')])))
      if (!results.length) throw new Error('The search provider returned no usable results; try another query')
      return text(results)
    }
    if (name === 'read_web_page') {
      let url = new URL(args.url)
      for (let i = 0; i <= 5; i++) {
        if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || !config.readDomains.includes(url.hostname)) throw new Error('Domain is not approved')
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { url = new URL(response.headers.get('location'), url); continue }
        const html = await responseText(response)
        return text(html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').slice(0, 100000))
      }
      throw new Error('Too many redirects')
    }
    throw new Error('Unknown tool')
  }
}
async function responseText(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reader = response.body.getReader(); const chunks = []; let size = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > MAX_FILE) { await reader.cancel(); throw new Error('Response is too large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function fetchText(url) { return responseText(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) })) }
function command(argv, cwd, cleanEnv, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    // Preserve the outer execution as ancestry, without pretending this child command
    // is a managed verification attempt (which requires its own complete manifest).
    const ancestors = [...new Set([...(JSON.parse(process.env.DESK_EXECUTION_ANCESTORS || '[]')), ...(process.env.DESK_ATTEMPT_ID ? [process.env.DESK_ATTEMPT_ID] : [])])]
    const env = cleanEnv ? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
      DESK_EXECUTION_ANCESTORS: JSON.stringify(ancestors) } : process.env
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''; let exceeded = false
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    const timer = setTimeout(() => { stop(); exceeded = true }, Math.min(timeoutMs, 3_600_000))
    const collect = (chunk) => { output += chunk.toString(); if (output.length > MAX_FILE) { exceeded = true; stop() } }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); if (exceeded) reject(new Error('Command exceeded limits')); else resolve(`exit ${code}\n${output}`) })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(process.argv[2])
  // The model can only access scoped tools, never the MCP process environment or /proc.
  const call = createTools(config)
  const emit = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n')
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    try {
      if (request.method === 'initialize') emit(request.id, { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'spec-review-desk', version: '1.0.0' } })
      else if (request.method === 'ping') emit(request.id, {})
      else if (request.method === 'tools/list') emit(request.id, { tools: toolDefinitions(config) })
      else if (request.method === 'tools/call') {
        try { emit(request.id, await call(request.params.name, request.params.arguments ?? {})) }
        catch (error) { emit(request.id, { isError: true, content: [{ type: 'text', text: error.message }] }) }
      } else emit(request.id, null, { code: -32601, message: 'Method not found' })
    } catch (error) { emit(request.id, null, { code: -32603, message: error.message }) }
  }
}
