import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AGENT_IMAGE, BROWSER_IMAGE, CLAUDE_CODE_VERSION, EGRESS_IMAGE, PLAYWRIGHT_MCP_VERSION } from './sandbox-args.ts'

const read = (rel: string): Promise<string> => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

describe('sandbox images (spec B §5)', () => {
  it('pins the CLI version in the agent image and runs it as uid 10001 without git', async () => {
    const dockerfile = await read('sandbox/agent/Dockerfile')
    expect(dockerfile).toContain('FROM node:22-slim')
    expect(dockerfile).toContain(`ARG CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`)
    expect(dockerfile).toContain('@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}')
    expect(dockerfile).toContain('--uid 10001')
    expect(dockerfile).toContain('USER agent')
    expect(dockerfile).not.toMatch(/apk add|\bgit\b/)
    // The only system package: poppler-utils, which the CLI's Read tool needs to render PDF inputs.
    const packages = [...dockerfile.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].map((m) => m[1]!.trim())
    expect(packages).toEqual(['poppler-utils'])
  })

  it('denies every host the filter does not list, and everything but HTTPS to port 443 (review fix 1)', async () => {
    const conf = await read('sandbox/egress/tinyproxy.conf')
    for (const line of ['Port 8888', 'ConnectPort 443', 'Filter "/etc/tinyproxy/filter"', 'FilterType ere', 'FilterURLs On', 'FilterDefaultDeny Yes']) {
      expect(conf.split('\n')).toContain(line)
    }
    expect(await read('sandbox/egress/Dockerfile')).toContain('USER 65534:65534')
  })

  it('builds the research browser on the Playwright image of the repo\'s Playwright version, with the MCP server pinned, as pwuser', async () => {
    const dockerfile = await read('sandbox/browser/Dockerfile')
    const lock = JSON.parse(await read('package-lock.json')) as { packages: Record<string, { version: string }> }
    const playwright = lock.packages['node_modules/@playwright/test']!.version
    expect(playwright).toBe('1.63.0')
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${playwright}-noble`)
    expect(dockerfile).toContain(`ARG PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION}`)
    expect(dockerfile).toContain('npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}')
    expect(dockerfile).toContain('USER pwuser')
    expect(dockerfile).toContain('ENTRYPOINT ["playwright-mcp"]')
    expect(dockerfile).not.toMatch(/apt-get install|playwright install|\bgit\b/)
  })

  it('builds the three images under the tags the Desk runs', async () => {
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['agent:build']).toBe(
      `docker build -t ${AGENT_IMAGE} --build-arg CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} sandbox/agent && docker build -t ${EGRESS_IMAGE} sandbox/egress` +
        ` && docker build -t ${BROWSER_IMAGE} --build-arg PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION} sandbox/browser`,
    )
  })
})
