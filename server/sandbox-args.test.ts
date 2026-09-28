import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE, agentRunArgs, agentTools, BROWSER_IMAGE, BROWSER_MCP_URL, BROWSER_TOOLS, browserMcpConfig, browserName, browserRunArgs,
  CLAUDE_CODE_VERSION, cleanupArgs, containerName, egressName, egressRunArgs, networkName, PLAYWRIGHT_MCP_VERSION, PROXY_URL, teardownArgs,
} from './sandbox-args.ts'

const container = {
  runId: 'r_0000abcd',
  image: AGENT_IMAGE,
  envFile: '/w/.spec-review/runs/r_0000abcd/agent.env',
  room: '/w/.spec-review/runs/r_0000abcd/room',
  out: '/w/.spec-review/runs/r_0000abcd/out',
  sessions: '/w/.spec-review/runs/r_0000abcd/sessions',
  claudeArgs: ['-p', '--model', 'opus'],
}
const pairs = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []))

describe('names', () => {
  it('derives per-run container, proxy and network names (ruling 1)', () => {
    expect(CLAUDE_CODE_VERSION).toBe('2.1.280')
    expect(AGENT_IMAGE).toBe('spec-review-agent:2.1.280')
    expect([containerName('r_1'), egressName('r_1'), networkName('r_1')]).toEqual(['sr-r_1', 'sr-egress-r_1', 'sr-net-r_1'])
    expect(PROXY_URL('r_1')).toBe('http://sr-egress-r_1:8888')
  })

  it('names the research browser per run and tags its image with the pinned Playwright MCP version', () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.80')
    expect(BROWSER_IMAGE).toBe('spec-review-browser:0.0.80')
    expect(browserName('r_1')).toBe('sr-browser-r_1')
    expect(BROWSER_MCP_URL('r_1')).toBe('http://sr-browser-r_1:8931/mcp')
    expect(JSON.parse(browserMcpConfig('r_1'))).toEqual({ mcpServers: { browser: { type: 'http', url: 'http://sr-browser-r_1:8931/mcp' } } })
  })
})

describe('agentRunArgs', () => {
  const args = agentRunArgs(container)

  it('isolates the container: internal network, read-only root, no capabilities, limits, non-root', () => {
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '-i', '--name', 'sr-r_0000abcd'])
    expect(pairs(args, '--network')).toEqual(['sr-net-r_0000abcd'])
    expect(args).toContain('--read-only')
    expect(pairs(args, '--tmpfs')).toEqual(['/tmp', '/home/agent:uid=10001,gid=10001'])
    expect(pairs(args, '--cap-drop')).toEqual(['ALL'])
    expect(pairs(args, '--security-opt')).toEqual(['no-new-privileges'])
    expect(pairs(args, '--pids-limit')).toEqual(['256'])
    expect(pairs(args, '--memory')).toEqual(['2g'])
    expect(pairs(args, '--cpus')).toEqual(['2'])
    expect(pairs(args, '--user')).toEqual(['10001:10001'])
  })

  it('passes the token only through the env file and switches telemetry off', () => {
    expect(pairs(args, '--env-file')).toEqual([container.envFile])
    expect(pairs(args, '-e')).toEqual([
      'HTTPS_PROXY=http://sr-egress-r_0000abcd:8888',
      'HTTP_PROXY=http://sr-egress-r_0000abcd:8888',
      'DISABLE_TELEMETRY=1',
      'DISABLE_ERROR_REPORTING=1',
      'DISABLE_AUTOUPDATER=1',
      'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    ])
    expect(args.join(' ')).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|-v \/var\/run\/docker\.sock/)
  })

  it('mounts exactly the room read-only, the output and the session store', () => {
    expect(pairs(args, '-v')).toEqual([
      `${container.room}:/work/in:ro`,
      `${container.out}:/work/out:rw`,
      `${container.sessions}:/home/agent/.claude:rw`,
    ])
    expect(pairs(args, '-w')).toEqual(['/work/in'])
    expect(args.slice(args.indexOf(AGENT_IMAGE))).toEqual([AGENT_IMAGE, 'claude', '-p', '--model', 'opus'])
  })

  it('without a browser: no MCP server and no proxy bypass', () => {
    expect(args.join(' ')).not.toMatch(/--mcp-config|NO_PROXY/)
    expect(agentRunArgs({ ...container, browser: false })).toEqual(args)
  })

  it('with the research browser: reaches it directly (NO_PROXY) and loads it as the one MCP server', () => {
    const withBrowser = agentRunArgs({ ...container, browser: true })
    expect(pairs(withBrowser, '-e')).toEqual([
      'HTTPS_PROXY=http://sr-egress-r_0000abcd:8888',
      'HTTP_PROXY=http://sr-egress-r_0000abcd:8888',
      // Spike 2026-09-28: without it the CLI sends its MCP requests through tinyproxy, which refuses them.
      'NO_PROXY=sr-browser-r_0000abcd',
      'DISABLE_TELEMETRY=1',
      'DISABLE_ERROR_REPORTING=1',
      'DISABLE_AUTOUPDATER=1',
      'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    ])
    expect(withBrowser.slice(withBrowser.indexOf(AGENT_IMAGE))).toEqual([
      AGENT_IMAGE, 'claude', '-p', '--model', 'opus',
      '--mcp-config={"mcpServers":{"browser":{"type":"http","url":"http://sr-browser-r_0000abcd:8931/mcp"}}}',
    ])
  })
})

describe('browserRunArgs', () => {
  const args = browserRunArgs('r_1', BROWSER_IMAGE)

  it('runs the Playwright MCP server on the run network only, locked down, without the token or host mounts', () => {
    expect(args).toEqual([
      'run', '-d', '--rm', '--name', 'sr-browser-r_1', '--network', 'sr-net-r_1',
      '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/pwuser:uid=1001,gid=1001', '--shm-size', '256m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2',
      '--user', '1001:1001',
      BROWSER_IMAGE,
      '--headless', '--browser', 'chromium', '--no-sandbox', '--isolated',
      '--host', '0.0.0.0', '--port', '8931', '--allowed-hosts', 'sr-browser-r_1:8931',
      '--proxy-server', 'http://sr-egress-r_1:8888',
    ])
    expect(args.join(' ')).not.toMatch(/--env-file|CLAUDE_CODE_OAUTH_TOKEN|-v |--volume|bridge|--network host/)
  })
})

describe('the egress proxy and teardown', () => {
  it('starts the proxy on the bridge with the run filter mounted read-only', () => {
    const args = egressRunArgs('r_1', 'spec-review-egress:1', '/w/runs/r_1/egress.filter')
    expect(args).toEqual([
      'run', '-d', '--rm', '--name', 'sr-egress-r_1', '--network', 'bridge', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-v', '/w/runs/r_1/egress.filter:/etc/tinyproxy/filter:ro', 'spec-review-egress:1',
    ])
  })

  it('removes the agent, the browser, the proxy and the network', () => {
    expect(teardownArgs('r_1')).toEqual([
      ['rm', '-f', 'sr-r_1'],
      ['rm', '-f', 'sr-browser-r_1'],
      ['rm', '-f', 'sr-egress-r_1'],
      ['network', 'rm', 'sr-net-r_1'],
    ])
  })

  it('deletes run directories as the agent user, without a network (ruling 6)', () => {
    const args = cleanupArgs(AGENT_IMAGE, ['/w/out', '/w/sessions'])
    expect(args.slice(0, 8)).toEqual(['run', '--rm', '--network', 'none', '--user', '10001:10001', '--entrypoint', 'node'])
    expect(pairs(args, '-v')).toEqual(['/w/out:/clean/0', '/w/sessions:/clean/1'])
    expect(args.slice(-2)).toEqual(['/clean/0', '/clean/1'])
  })
})

describe('agentTools', () => {
  const proc = ['Read(//proc/**)', 'Read(//sys/**)', 'Grep(//proc/**)', 'Grep(//sys/**)', 'Glob(//proc/**)', 'Glob(//sys/**)']

  it('lets the author write, never run a shell or reach the web', () => {
    expect(agentTools('author', false)).toEqual({
      allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      disallowed: ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', ...proc],
      permissionMode: 'acceptEdits',
    })
  })

  it('keeps the planner read-only', () => {
    expect(agentTools('planner', false)).toEqual({
      allowed: ['Read', 'Grep', 'Glob'],
      disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', ...proc],
      permissionMode: 'default',
    })
  })

  it('gives research WebSearch, and WebFetch plus the browser only in the read phase', () => {
    expect(agentTools('research', false)).toEqual({
      allowed: ['Read', 'Grep', 'Glob', 'WebSearch'],
      disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', ...proc],
      permissionMode: 'default',
    })
    const read = agentTools('research', true)
    expect(read.allowed).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', ...BROWSER_TOOLS])
    expect(read.disallowed.slice(0, 10)).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', ...proc])
    expect(read.permissionMode).toBe('default')
  })

  it('never gives the planner or the author the browser', () => {
    for (const kind of ['planner', 'author'] as const) {
      for (const web of [false, true]) expect(agentTools(kind, web).allowed.join(',')).not.toContain('mcp__')
    }
  })

  // The tools/list of @playwright/mcp 0.0.80 in the 2026-09-28 spike. Every one is either allowed or
  // explicitly denied (a denied tool is not even shown to the model); a new version must be re-classified.
  const MCP_TOOLS = [
    'browser_close', 'browser_resize', 'browser_console_messages', 'browser_handle_dialog', 'browser_evaluate', 'browser_file_upload',
    'browser_drop', 'browser_find', 'browser_fill_form', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_navigate_back',
    'browser_network_requests', 'browser_network_request', 'browser_run_code_unsafe', 'browser_take_screenshot', 'browser_snapshot',
    'browser_click', 'browser_drag', 'browser_hover', 'browser_select_option', 'browser_tabs', 'browser_wait_for',
  ].map((t) => `mcp__browser__${t}`)

  it('allows a minimal browser set and denies every other tool of the pinned MCP version', () => {
    expect(BROWSER_TOOLS).toEqual([
      'mcp__browser__browser_navigate', 'mcp__browser__browser_navigate_back', 'mcp__browser__browser_snapshot',
      'mcp__browser__browser_click', 'mcp__browser__browser_wait_for', 'mcp__browser__browser_network_requests',
    ])
    const { allowed, disallowed } = agentTools('research', true)
    const denied = disallowed.filter((t) => t.startsWith('mcp__'))
    expect([...BROWSER_TOOLS, ...denied].sort()).toEqual([...MCP_TOOLS].sort())
    expect(allowed.filter((t) => denied.includes(t))).toEqual([])
    for (const t of ['evaluate', 'run_code_unsafe', 'file_upload', 'take_screenshot', 'fill_form', 'type']) expect(denied).toContain(`mcp__browser__browser_${t}`)
  })
})
