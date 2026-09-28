import type { RunKind } from './initiative-store.ts'

// Spec B §5: every docker argv the Desk runs, built from validated values only (never a shell).
// Verified in the 2026-09-24 spike: node:22-slim + @anthropic-ai/claude-code 2.1.280, uid 10001,
// tinyproxy on an --internal network, read-only root with tmpfs /tmp and /home/agent.
export const CLAUDE_CODE_VERSION = '2.1.280'
export const AGENT_IMAGE = `spec-review-agent:${CLAUDE_CODE_VERSION}`
// :2 — the HTTPS-only proxy config (FilterURLs On, host:443 filter lines; review fix 1).
export const EGRESS_IMAGE = 'spec-review-egress:2'
// The research browser (spike 2026-09-28): the Playwright MCP server over HTTP in the official
// Playwright image of the repo's Playwright version (1.63.0). 0.0.80 is the last @playwright/mcp built
// on Playwright 1.63 — 0.0.81+ want Chromium 1246 (Playwright 1.64), which that image does not carry.
export const PLAYWRIGHT_MCP_VERSION = '0.0.80'
export const BROWSER_IMAGE = `spec-review-browser:${PLAYWRIGHT_MCP_VERSION}`
export const BROWSER_USER = '1001:1001'
export const BROWSER_PORT = 8931
export const AGENT_USER = '10001:10001'
export const EGRESS_PORT = 8888
export const WORK_IN = '/work/in'
export const WORK_OUT = '/work/out'
// The claude config dir, sessions included. Mounted whole: a bind mount below the /home/agent tmpfs
// would leave a root-owned ~/.claude the agent user cannot write.
export const SESSION_STORE = '/home/agent/.claude'

export const containerName = (runId: string): string => `sr-${runId}`
export const egressName = (runId: string): string => `sr-egress-${runId}`
export const networkName = (runId: string): string => `sr-net-${runId}`
// Review fix 1: each proxy's way out is its own per-run bridge, never the shared default bridge, so a
// proxy cannot reach other containers.
export const outNetworkName = (runId: string): string => `sr-out-${runId}`
export const browserOutNetworkName = (runId: string): string => `sr-bout-${runId}`
// Run ids are r_<8 hex>: these hostnames carry an underscore, which Docker DNS, Chromium, the MCP
// host check, the CLI's MCP client and NO_PROXY all accept (real docker, review fix 2).
export const browserName = (runId: string): string => `sr-browser-${runId}`
// Controller ruling 2: the browser's own proxy and network. The browser shares no network with the
// agent's proxy (the only one that reaches api.anthropic.com) — not even code running in the browser
// container (Chromium runs --no-sandbox) can use it.
export const browserProxyName = (runId: string): string => `sr-bproxy-${runId}`
export const browserNetworkName = (runId: string): string => `sr-bnet-${runId}`
export const PROXY_URL = (runId: string): string => `http://${egressName(runId)}:${EGRESS_PORT}`
export const BROWSER_PROXY_URL = (runId: string): string => `http://${browserProxyName(runId)}:${EGRESS_PORT}`
export const BROWSER_MCP_URL = (runId: string): string => `http://${browserName(runId)}:${BROWSER_PORT}/mcp`

// The one MCP server a research agent ever gets (read phase only); --strict-mcp-config keeps every
// other MCP configuration out.
export const browserMcpConfig = (runId: string): string =>
  JSON.stringify({ mcpServers: { browser: { type: 'http', url: BROWSER_MCP_URL(runId) } } })

export interface AgentContainer {
  runId: string
  image: string
  envFile: string
  room: string
  out: string
  sessions: string
  claudeArgs: readonly string[]
  // The research read phase: the agent also joins the browser network, talks to sr-browser-<run>
  // directly (NO_PROXY — through the proxy the CLI's MCP requests are refused) and loads it as its
  // MCP server.
  browser?: boolean
}

export function agentRunArgs(c: AgentContainer): string[] {
  return [
    'run', '--rm', '-i', '--name', containerName(c.runId),
    '--network', networkName(c.runId),
    // Two --network flags need Docker >= 25. The agent is dual-homed (sr-net and sr-bnet); isolation
    // relies on --cap-drop ALL here and on the browser — never add NET_ADMIN/NET_RAW, or the agent could
    // become a route from the browser to the agent's proxy.
    ...(c.browser ? ['--network', browserNetworkName(c.runId)] : []),
    '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/agent:uid=10001,gid=10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--user', AGENT_USER,
    '--env-file', c.envFile,
    '-e', `HTTPS_PROXY=${PROXY_URL(c.runId)}`,
    '-e', `HTTP_PROXY=${PROXY_URL(c.runId)}`,
    ...(c.browser ? ['-e', `NO_PROXY=${browserName(c.runId)}`] : []),
    '-e', 'DISABLE_TELEMETRY=1',
    '-e', 'DISABLE_ERROR_REPORTING=1',
    '-e', 'DISABLE_AUTOUPDATER=1',
    '-e', `CLAUDE_CONFIG_DIR=${SESSION_STORE}`,
    '-v', `${c.room}:${WORK_IN}:ro`,
    '-v', `${c.out}:${WORK_OUT}:rw`,
    '-v', `${c.sessions}:${SESSION_STORE}:rw`,
    '-w', WORK_IN,
    c.image, 'claude', ...c.claudeArgs,
    ...(c.browser ? [`--mcp-config=${browserMcpConfig(c.runId)}`] : []),
  ]
}

// The research browser: on the --internal browser network only (no route out but its own proxy),
// every page request through the browser filter (approved domains only), read-only root, no
// capabilities, no host mounts, no token. Chromium's own sandbox is off (--no-sandbox): it needs capabilities the container drops, and
// the container is the sandbox. --allowed-hosts: the MCP server answers only requests addressed to
// sr-browser-<run>:8931 — one to localhost:8931 (a page's script, say) gets 403 (spike 2026-09-28).
// --init: docker-init is PID 1 and reaps orphaned Chromium helpers, which would otherwise count
// against --pids-limit (review fix 4).
export const browserRunArgs = (runId: string, image: string): string[] => [
  'run', '-d', '--rm', '--init', '--name', browserName(runId), '--network', browserNetworkName(runId),
  '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/pwuser:uid=1001,gid=1001', '--shm-size', '256m',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2',
  '--user', BROWSER_USER,
  image,
  '--headless', '--browser', 'chromium', '--no-sandbox', '--isolated',
  '--host', '0.0.0.0', '--port', String(BROWSER_PORT), '--allowed-hosts', `${browserName(runId)}:${BROWSER_PORT}`,
  '--proxy-server', BROWSER_PROXY_URL(runId),
]

export const networkCreateArgs = (runId: string): string[] => ['network', 'create', '--internal', networkName(runId)]

// A tinyproxy on its own per-run bridge (its way out), joined to one internal network afterwards.
// Limits (review fix 4): tinyproxy serves at most 20 clients (tinyproxy.conf MaxClients).
const proxyRunArgs = (name: string, outNetwork: string, image: string, filterFile: string): string[] => [
  'run', '-d', '--rm', '--name', name, '--network', outNetwork, '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
  '-v', `${filterFile}:/etc/tinyproxy/filter:ro`, image,
]

export const outNetworkCreateArgs = (runId: string): string[] => ['network', 'create', outNetworkName(runId)]

export const egressRunArgs = (runId: string, image: string, filterFile: string): string[] =>
  proxyRunArgs(egressName(runId), outNetworkName(runId), image, filterFile)

export const networkConnectArgs = (runId: string): string[] => ['network', 'connect', networkName(runId), egressName(runId)]

export const browserNetworkCreateArgs = (runId: string): string[] => ['network', 'create', '--internal', browserNetworkName(runId)]

export const browserOutNetworkCreateArgs = (runId: string): string[] => ['network', 'create', browserOutNetworkName(runId)]

export const browserProxyRunArgs = (runId: string, image: string, filterFile: string): string[] =>
  proxyRunArgs(browserProxyName(runId), browserOutNetworkName(runId), image, filterFile)

export const browserProxyConnectArgs = (runId: string): string[] => ['network', 'connect', browserNetworkName(runId), browserProxyName(runId)]

export const teardownArgs = (runId: string): string[][] => [
  ['rm', '-f', containerName(runId)],
  ['rm', '-f', browserName(runId)],
  ['rm', '-f', browserProxyName(runId)],
  ['rm', '-f', egressName(runId)],
  ['network', 'rm', browserNetworkName(runId)],
  ['network', 'rm', browserOutNetworkName(runId)],
  ['network', 'rm', networkName(runId)],
  ['network', 'rm', outNetworkName(runId)],
]

// Ruling 6: files the agent wrote belong to uid 10001, so a container running as that user empties
// the run's output and session directories; the host then removes the directories themselves.
const EMPTY_DIRS =
  "const fs=require('fs');for(const d of process.argv.slice(1))for(const e of fs.readdirSync(d))fs.rmSync(d+'/'+e,{recursive:true,force:true})"

export function cleanupArgs(image: string, dirs: readonly string[]): string[] {
  const targets = dirs.map((_, i) => `/clean/${i}`)
  return [
    'run', '--rm', '--network', 'none', '--user', AGENT_USER, '--entrypoint', 'node',
    ...dirs.flatMap((d, i) => ['-v', `${d}:${targets[i]}`]),
    image, '-e', EMPTY_DIRS, ...targets,
  ]
}

// Read/Grep/Glob never see /proc or /sys, where the claude process environment (and so the OAuth
// token) is readable (spec B §5.2).
const PROC_DENY = ['Read(//proc/**)', 'Read(//sys/**)', 'Grep(//proc/**)', 'Grep(//sys/**)', 'Glob(//proc/**)', 'Glob(//sys/**)']

export interface AgentTools { allowed: string[]; disallowed: string[]; permissionMode: 'default' | 'acceptEdits' }

const browserTool = (name: string): string => `mcp__browser__browser_${name}`
// The minimal browser set of the research read phase: open, read (the accessibility snapshot), follow
// links, wait for a page to render, and list its requests (to see which hosts the proxy blocked).
export const BROWSER_TOOLS = ['navigate', 'navigate_back', 'snapshot', 'click', 'wait_for', 'network_requests'].map(browserTool)
// Every other tool of @playwright/mcp 0.0.80 is denied by name, so the model never sees it: no script
// evaluation, no file upload or screenshots to disk, no typing into forms.
const BROWSER_DENIED = [
  'evaluate', 'run_code_unsafe', 'file_upload', 'take_screenshot', 'fill_form', 'type', 'press_key', 'select_option', 'drag', 'drop',
  'hover', 'handle_dialog', 'tabs', 'resize', 'close', 'console_messages', 'network_request', 'find',
].map(browserTool)

export function agentTools(kind: RunKind, webFetch: boolean): AgentTools {
  if (kind === 'author') {
    return {
      allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      disallowed: ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', ...PROC_DENY],
      permissionMode: 'acceptEdits',
    }
  }
  if (kind === 'planner') {
    return {
      allowed: ['Read', 'Grep', 'Glob'],
      disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', ...PROC_DENY],
      permissionMode: 'default',
    }
  }
  // The read phase (approved domains): WebFetch and the browser, both behind the run's egress filter.
  return {
    allowed: ['Read', 'Grep', 'Glob', 'WebSearch', ...(webFetch ? ['WebFetch', ...BROWSER_TOOLS] : [])],
    disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', ...(webFetch ? [] : ['WebFetch']), ...PROC_DENY, ...(webFetch ? BROWSER_DENIED : [])],
    permissionMode: 'default',
  }
}
