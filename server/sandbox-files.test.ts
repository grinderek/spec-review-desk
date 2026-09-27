import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AGENT_IMAGE, CLAUDE_CODE_VERSION, EGRESS_IMAGE } from './sandbox-args.ts'

const read = (rel: string): Promise<string> => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

describe('sandbox images (spec B §5)', () => {
  it('pins the CLI version in the agent image and runs it as uid 10001 without git', async () => {
    const dockerfile = await read('sandbox/agent/Dockerfile')
    expect(dockerfile).toContain('FROM node:22-slim')
    expect(dockerfile).toContain(`ARG CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`)
    expect(dockerfile).toContain('@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}')
    expect(dockerfile).toContain('--uid 10001')
    expect(dockerfile).toContain('USER agent')
    expect(dockerfile).not.toMatch(/apt-get|apk add|\bgit\b/)
  })

  it('denies every host the filter does not list', async () => {
    const conf = await read('sandbox/egress/tinyproxy.conf')
    for (const line of ['Port 8888', 'ConnectPort 443', 'Filter "/etc/tinyproxy/filter"', 'FilterType ere', 'FilterURLs Off', 'FilterDefaultDeny Yes']) {
      expect(conf.split('\n')).toContain(line)
    }
    expect(await read('sandbox/egress/Dockerfile')).toContain('USER 65534:65534')
  })

  it('builds both images under the tags the Desk runs', async () => {
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['agent:build']).toBe(
      `docker build -t ${AGENT_IMAGE} --build-arg CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} sandbox/agent && docker build -t ${EGRESS_IMAGE} sandbox/egress`,
    )
  })
})
