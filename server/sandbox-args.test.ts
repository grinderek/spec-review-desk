import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE, agentRunArgs, agentTools, CLAUDE_CODE_VERSION, cleanupArgs, containerName, egressName, egressRunArgs, networkName, PROXY_URL,
  teardownArgs,
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
})

describe('the egress proxy and teardown', () => {
  it('starts the proxy on the bridge with the run filter mounted read-only', () => {
    const args = egressRunArgs('r_1', 'spec-review-egress:1', '/w/runs/r_1/egress.filter')
    expect(args).toEqual([
      'run', '-d', '--rm', '--name', 'sr-egress-r_1', '--network', 'bridge', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-v', '/w/runs/r_1/egress.filter:/etc/tinyproxy/filter:ro', 'spec-review-egress:1',
    ])
  })

  it('removes the agent, the proxy and the network', () => {
    expect(teardownArgs('r_1')).toEqual([
      ['rm', '-f', 'sr-r_1'],
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

  it('gives research WebSearch, and WebFetch only in the read phase', () => {
    expect(agentTools('research', false)).toEqual({
      allowed: ['Read', 'Grep', 'Glob', 'WebSearch'],
      disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', ...proc],
      permissionMode: 'default',
    })
    expect(agentTools('research', true)).toEqual({
      allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      disallowed: ['Bash', 'Write', 'Edit', 'NotebookEdit', ...proc],
      permissionMode: 'default',
    })
  })
})
