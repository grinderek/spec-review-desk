import type { RunKind } from './initiative-store.ts'

// Spec B §5: every docker argv the Desk runs, built from validated values only (never a shell).
// Verified in the 2026-09-24 spike: node:22-slim + @anthropic-ai/claude-code 2.1.280, uid 10001,
// tinyproxy on an --internal network, read-only root with tmpfs /tmp and /home/agent.
export const CLAUDE_CODE_VERSION = '2.1.280'
export const AGENT_IMAGE = `spec-review-agent:${CLAUDE_CODE_VERSION}`
export const EGRESS_IMAGE = 'spec-review-egress:1'
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
export const PROXY_URL = (runId: string): string => `http://${egressName(runId)}:${EGRESS_PORT}`

export interface AgentContainer {
  runId: string
  image: string
  envFile: string
  room: string
  out: string
  sessions: string
  claudeArgs: readonly string[]
}

export function agentRunArgs(c: AgentContainer): string[] {
  return [
    'run', '--rm', '-i', '--name', containerName(c.runId),
    '--network', networkName(c.runId),
    '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/agent:uid=10001,gid=10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--user', AGENT_USER,
    '--env-file', c.envFile,
    '-e', `HTTPS_PROXY=${PROXY_URL(c.runId)}`,
    '-e', `HTTP_PROXY=${PROXY_URL(c.runId)}`,
    '-e', 'DISABLE_TELEMETRY=1',
    '-e', 'DISABLE_ERROR_REPORTING=1',
    '-e', 'DISABLE_AUTOUPDATER=1',
    '-e', `CLAUDE_CONFIG_DIR=${SESSION_STORE}`,
    '-v', `${c.room}:${WORK_IN}:ro`,
    '-v', `${c.out}:${WORK_OUT}:rw`,
    '-v', `${c.sessions}:${SESSION_STORE}:rw`,
    '-w', WORK_IN,
    c.image, 'claude', ...c.claudeArgs,
  ]
}

export const networkCreateArgs = (runId: string): string[] => ['network', 'create', '--internal', networkName(runId)]

export const egressRunArgs = (runId: string, image: string, filterFile: string): string[] => [
  'run', '-d', '--rm', '--name', egressName(runId), '--network', 'bridge', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '-v', `${filterFile}:/etc/tinyproxy/filter:ro`, image,
]

export const networkConnectArgs = (runId: string): string[] => ['network', 'connect', networkName(runId), egressName(runId)]

export const teardownArgs = (runId: string): string[][] => [
  ['rm', '-f', containerName(runId)],
  ['rm', '-f', egressName(runId)],
  ['network', 'rm', networkName(runId)],
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
  return {
    allowed: ['Read', 'Grep', 'Glob', 'WebSearch', ...(webFetch ? ['WebFetch'] : [])],
    disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', ...(webFetch ? [] : ['WebFetch']), ...PROC_DENY],
    permissionMode: 'default',
  }
}
