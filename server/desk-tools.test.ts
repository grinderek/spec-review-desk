import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTools, toolDefinitions } from './desk-tools.mjs'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sr-mcp-'))
  await mkdir(path.join(root, 'input'))
  await mkdir(path.join(root, 'output'))
  await writeFile(path.join(root, 'input', 'brief.md'), 'The approved feature.')
})
afterEach(() => vi.unstubAllGlobals())

describe('scoped Codex MCP tools', () => {
  it('keeps reviewer/planner read-only and limits author writes to output', async () => {
    const reviewer = createTools({ root: path.join(root, 'input') })
    expect(toolDefinitions({ root }).map((t) => t.name)).toEqual(['read_file', 'list_files', 'search_text'])
    await expect(reviewer('write_file', { path: 'brief.md', content: 'changed' })).rejects.toThrow(/not permitted/)
    const author = createTools({ root: path.join(root, 'input'), writeRoot: path.join(root, 'output') })
    await author('write_file', { path: 'features/test.feature', content: 'Feature: Test' })
    expect(await readFile(path.join(root, 'output', 'features', 'test.feature'), 'utf8')).toBe('Feature: Test')
    await expect(author('write_file', { path: path.join(root, 'input', 'brief.md'), content: 'changed' })).rejects.toThrow(/outside/)
  })
  it('blocks traversal, symlink escapes, secrets and internal directories', async () => {
    const call = createTools({ root: path.join(root, 'input'), writeRoot: path.join(root, 'input') })
    await writeFile(path.join(root, 'outside.txt'), 'secret')
    await writeFile(path.join(root, 'input', '.env'), 'API_KEY=secret')
    await symlink(root, path.join(root, 'input', 'escape'))
    for (const file of ['../outside.txt', '/proc/self/environ', '.env', 'escape/outside.txt']) await expect(call('read_file', { path: file })).rejects.toThrow()
    await expect(call('write_file', { path: 'escape/new.txt', content: 'escape' })).rejects.toThrow(/Symlink/)
    const listed = await call('list_files', {})
    expect(listed.content[0]!.text).toBe('["brief.md"]')
  })
  it('runs allowed argv without a shell and rejects unapproved commands and global git options', async () => {
    const call = createTools({ root, commands: ['git'], deniedCommands: ['git push', 'git reset', 'git rebase'] })
    expect((await call('run_command', { argv: ['git', 'status', '--short'] })).content[0]!.text).toMatch(/^exit /)
    for (const argv of [['sh', '-c', 'touch bad'], ['git', 'push'], ['git', 'status', '--git-dir=/tmp']]) await expect(call('run_command', { argv })).rejects.toThrow(/allowlist/)
  })
  it('searches only the fixed search endpoint and does not open result URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<rss><item><title>A &amp; B</title><link>https://example.com/</link><description>Snippet</description></item></rss>'))
    vi.stubGlobal('fetch', fetch)
    const call = createTools({ root, search: true })
    expect((await call('search_web', { query: 'event sourcing' })).content[0]!.text).toContain('A & B')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0].hostname).toBe('www.bing.com')
    await expect(call('read_web_page', { url: 'https://example.com/' })).rejects.toThrow(/not permitted/)
  })
  it('checks every redirect against the owner-approved domains', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
    vi.stubGlobal('fetch', fetch)
    const call = createTools({ root, readDomains: ['docs.example.com'] })
    await expect(call('read_web_page', { url: 'https://docs.example.com/' })).rejects.toThrow(/not approved/)
    expect(fetch).toHaveBeenCalledTimes(1)
    for (const url of ['http://docs.example.com/', 'https://docs.example.com:444/', 'https://user:pass@docs.example.com/']) await expect(call('read_web_page', { url })).rejects.toThrow(/not approved/)
  })
})
