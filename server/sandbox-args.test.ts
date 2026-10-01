import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE, agentRunArgs, agentTools, BROWSER_IMAGE, BROWSER_MCP_URL, BROWSER_PROXY_URL, BROWSER_TOOLS, browserName,
  browserNetworkCreateArgs, browserNetworkName, browserProxyConnectArgs, browserProxyName, browserProxyRunArgs, browserRunArgs, CODEX_VERSION,
  browserOutNetworkCreateArgs, browserOutNetworkName, cleanupArgs, containerName, EGRESS_IMAGE, egressName, egressRunArgs, networkConnectArgs,
  networkCreateArgs, networkName, outNetworkCreateArgs, outNetworkName, PLAYWRIGHT_MCP_VERSION, PROXY_URL, teardownArgs,
} from './sandbox-args.ts'
import { newId } from './review-store.ts'

const container = {
  runId: 'r_0000abcd',
  image: AGENT_IMAGE,
  envFile: '/w/.spec-review/runs/r_0000abcd/agent.env',
  room: '/w/.spec-review/runs/r_0000abcd/room',
  out: '/w/.spec-review/runs/r_0000abcd/out',
  sessions: '/w/.spec-review/runs/r_0000abcd/sessions',
  codexArgs: ['-p', '--model', 'gpt-5.4'],
}
const pairs = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []))

describe('names', () => {
  it('derives per-run container, proxy and network names (ruling 1)', () => {
    expect(CODEX_VERSION).toBe('0.159.3')
    expect(AGENT_IMAGE).toBe('spec-review-codex:0.159.3-auth1')
    expect([containerName('r_1'), egressName('r_1'), networkName('r_1')]).toEqual(['sr-r_1', 'sr-egress-r_1', 'sr-net-r_1'])
    expect(PROXY_URL('r_1')).toBe('http://sr-egress-r_1:8888')
    // Review fix 1: each proxy's way out is its own per-run bridge, never the shared default bridge.
    expect([outNetworkName('r_1'), browserOutNetworkName('r_1')]).toEqual(['sr-out-r_1', 'sr-bout-r_1'])
    // The tag moved with the HTTPS-only proxy config (FilterURLs On): an old :1 image would deny everything.
    expect(EGRESS_IMAGE).toBe('spec-review-egress:2')
  })

  it('names the research browser per run and tags its image with the pinned Playwright MCP version', () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.80')
    expect(BROWSER_IMAGE).toBe('spec-review-browser:0.0.80')
    expect(browserName('r_1')).toBe('sr-browser-r_1')
    expect(BROWSER_MCP_URL('r_1')).toBe('http://sr-browser-r_1:8931/mcp')
    // Controller ruling 2: the browser has its own proxy on its own internal network.
    expect([browserProxyName('r_1'), browserNetworkName('r_1')]).toEqual(['sr-bproxy-r_1', 'sr-bnet-r_1'])
    expect(BROWSER_PROXY_URL('r_1')).toBe('http://sr-bproxy-r_1:8888')
  })
})

describe('real run ids (review fix 2)', () => {
  // Run ids are r_<8 hex>, so every per-run hostname carries an underscore. Verified with real docker
  // (2026-09-28, run id r_0badc0de): Docker DNS, Chromium's --proxy-server, the MCP host check, the
  // claude CLI's MCP client and NO_PROXY all accept it — no network aliases needed.
  it('keeps the underscore in every hostname the agent, the browser and the proxies use', () => {
    const id = newId('r')
    expect(id).toMatch(/^r_[0-9a-f]{8}$/)
    expect(new URL(BROWSER_MCP_URL(id)).host).toBe(`sr-browser-${id}:8931`)
    expect(new URL(BROWSER_PROXY_URL(id)).host).toBe(`sr-bproxy-${id}:8888`)
    expect(new URL(PROXY_URL(id)).host).toBe(`sr-egress-${id}:8888`)
    expect(agentRunArgs({ ...container, runId: id, browser: true })).toEqual(
      expect.arrayContaining([`NO_PROXY=sr-browser-${id}`, `mcp_servers.browser.url="${BROWSER_MCP_URL(id)}"`]),
    )
    expect(browserRunArgs(id, BROWSER_IMAGE)).toEqual(
      expect.arrayContaining(['--allowed-hosts', `sr-browser-${id}:8931`, '--proxy-server', `http://sr-bproxy-${id}:8888`]),
    )
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
      'https_proxy=http://sr-egress-r_0000abcd:8888',
      'http_proxy=http://sr-egress-r_0000abcd:8888',
      'NO_PROXY=',
      'no_proxy=',
      'CODEX_HOME=/home/agent/.codex',
      'NODE_USE_ENV_PROXY=1',
    ])
    expect(args.join(' ')).not.toMatch(/OPENAI_API_KEY|-v \/var\/run\/docker\.sock/)
  })

  it('mounts exactly the room read-only, the output and the session store', () => {
    expect(pairs(args, '-v')).toEqual([
      `${container.room}:/work/in:ro`,
      `${container.out}:/work/out:rw`,
      `${container.sessions}:/home/agent/.codex:rw`,
    ])
    expect(pairs(args, '-w')).toEqual(['/work/in'])
    expect(args.slice(args.indexOf(AGENT_IMAGE))).toEqual([AGENT_IMAGE, 'codex', '-p', '--model', 'gpt-5.4'])
  })

  it('without a browser: no MCP server and no proxy bypass', () => {
    expect(args).toContain('NO_PROXY=')
    expect(args).toContain('no_proxy=')
    expect(agentRunArgs({ ...container, browser: false })).toEqual(args)
  })

  it('with the research browser: reaches it directly (NO_PROXY) and loads it as the one MCP server', () => {
    const withBrowser = agentRunArgs({ ...container, browser: true })
    // On the run network (its proxy) and the browser network (the MCP server) — the browser is not on the first.
    expect(pairs(withBrowser, '--network')).toEqual(['sr-net-r_0000abcd', 'sr-bnet-r_0000abcd'])
    expect(pairs(withBrowser, '-e')).toEqual([
      'HTTPS_PROXY=http://sr-egress-r_0000abcd:8888',
      'HTTP_PROXY=http://sr-egress-r_0000abcd:8888',
      'https_proxy=http://sr-egress-r_0000abcd:8888',
      'http_proxy=http://sr-egress-r_0000abcd:8888',
      // Spike 2026-09-28: without it the CLI sends its MCP requests through tinyproxy, which refuses them.
      'NO_PROXY=sr-browser-r_0000abcd',
      'no_proxy=sr-browser-r_0000abcd',
      'CODEX_HOME=/home/agent/.codex',
      'NODE_USE_ENV_PROXY=1',
    ])
    expect(withBrowser.slice(withBrowser.indexOf(AGENT_IMAGE))).toEqual([
      AGENT_IMAGE, 'codex', '-p', '--model', 'gpt-5.4',
      '-c', 'mcp_servers.browser.url="http://sr-browser-r_0000abcd:8931/mcp"',
      '-c', 'mcp_servers.browser.enabled_tools=["browser_navigate","browser_navigate_back","browser_snapshot","browser_click","browser_wait_for","browser_network_requests"]',
      '-c', 'mcp_servers.browser.required=true',
    ])
  })
})

describe('browserRunArgs', () => {
  const args = browserRunArgs('r_1', BROWSER_IMAGE)

  it('runs the Playwright MCP server on the browser network only, behind its own proxy, locked down, without the token or host mounts', () => {
    expect(args).toEqual([
      // --init (review fix 4): docker-init is PID 1 and reaps orphaned Chromium helpers.
      'run', '-d', '--rm', '--init', '--name', 'sr-browser-r_1', '--network', 'sr-bnet-r_1',
      '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/pwuser:uid=1001,gid=1001', '--shm-size', '256m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2',
      '--user', '1001:1001',
      BROWSER_IMAGE,
      '--headless', '--browser', 'chromium', '--no-sandbox', '--isolated',
      '--host', '0.0.0.0', '--port', '8931', '--allowed-hosts', 'sr-browser-r_1:8931',
      '--proxy-server', 'http://sr-bproxy-r_1:8888',
    ])
    expect(args.join(' ')).not.toMatch(/--env-file|OPENAI_API_KEY|-v |--volume|bridge|--network host|sr-egress|sr-net-/)
  })

  it('gives the browser its own hardened proxy, reachable only from the browser network (controller ruling 2)', () => {
    expect(browserNetworkCreateArgs('r_1')).toEqual(['network', 'create', '--internal', 'sr-bnet-r_1'])
    expect(browserOutNetworkCreateArgs('r_1')).toEqual(['network', 'create', 'sr-bout-r_1'])
    expect(browserProxyRunArgs('r_1', 'spec-review-egress:2', '/w/runs/r_1/browser.filter')).toEqual([
      'run', '-d', '--rm', '--name', 'sr-bproxy-r_1', '--network', 'sr-bout-r_1', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
      '-v', '/w/runs/r_1/browser.filter:/etc/tinyproxy/filter:ro', 'spec-review-egress:2',
    ])
    expect(browserProxyConnectArgs('r_1')).toEqual(['network', 'connect', 'sr-bnet-r_1', 'sr-bproxy-r_1'])
    // The agent's proxy stays on the run network only.
    expect(networkCreateArgs('r_1')).toEqual(['network', 'create', '--internal', 'sr-net-r_1'])
    expect(outNetworkCreateArgs('r_1')).toEqual(['network', 'create', 'sr-out-r_1'])
    expect(networkConnectArgs('r_1')).toEqual(['network', 'connect', 'sr-net-r_1', 'sr-egress-r_1'])
  })
})

describe('the egress proxy and teardown', () => {
  it('starts the proxy on its own per-run bridge with the run filter mounted read-only', () => {
    const args = egressRunArgs('r_1', 'spec-review-egress:2', '/w/runs/r_1/egress.filter')
    expect(args).toEqual([
      'run', '-d', '--rm', '--name', 'sr-egress-r_1', '--network', 'sr-out-r_1', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
      '-v', '/w/runs/r_1/egress.filter:/etc/tinyproxy/filter:ro', 'spec-review-egress:2',
    ])
    expect(args).not.toContain('bridge')
  })

  it('removes the agent, the browser, both proxies and all four networks', () => {
    expect(teardownArgs('r_1')).toEqual([
      ['rm', '-f', 'sr-r_1'],
      ['rm', '-f', 'sr-browser-r_1'],
      ['rm', '-f', 'sr-bproxy-r_1'],
      ['rm', '-f', 'sr-egress-r_1'],
      ['network', 'rm', 'sr-bnet-r_1'],
      ['network', 'rm', 'sr-bout-r_1'],
      ['network', 'rm', 'sr-net-r_1'],
      ['network', 'rm', 'sr-out-r_1'],
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
