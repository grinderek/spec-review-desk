import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AGENT_IMAGE, BROWSER_IMAGE, CODEX_VERSION, EGRESS_IMAGE, PLAYWRIGHT_MCP_VERSION } from './sandbox-args.ts'

const read = (rel: string): Promise<string> => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

describe('sandbox images (spec B §5)', () => {
  it('pins the CLI version in the agent image and runs it as uid 10001 without git', async () => {
    const dockerfile = await read('sandbox/agent/Dockerfile')
    expect(dockerfile).toContain('ARG NODE_IMAGE=node:24-slim')
    expect(dockerfile).toContain(`ARG CODEX_VERSION=${CODEX_VERSION}`)
    expect(dockerfile).toContain('@openai/codex@${CODEX_VERSION}')
    expect(dockerfile).toContain('--uid 10001')
    expect(dockerfile).toContain('USER agent')
    expect(dockerfile).not.toMatch(/apk add|\bgit\b/)
    // PDF extraction, TLS trust and the OS lock for refreshable subscription credentials.
    const packages = [...dockerfile.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].map((m) => m[1]!.trim())
    expect(packages).toEqual(['poppler-utils ca-certificates util-linux'])
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
    // Review fix 4: the tag names the version, the digest pins the bytes.
    expect(dockerfile).toMatch(new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:v${playwright.replace(/\./g, '\\.')}-noble@sha256:[0-9a-f]{64}$`, 'm'))
    expect(dockerfile).toContain(`ARG PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION}`)
    expect(dockerfile).toContain('npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}')
    expect(dockerfile).toContain('USER pwuser')
    expect(dockerfile).toContain('ENTRYPOINT ["playwright-mcp"]')
    expect(dockerfile).not.toMatch(/apt-get install|playwright install|\bgit\b/)
  })

  it('builds the three images under the tags the Desk runs', async () => {
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['agent:build']).toBe(
      `docker build -t ${AGENT_IMAGE} --build-arg CODEX_VERSION=${CODEX_VERSION} -f sandbox/agent/Dockerfile . && docker build -t ${EGRESS_IMAGE} sandbox/egress` +
        ` && docker build -t ${BROWSER_IMAGE} --build-arg PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION} sandbox/browser`,
    )
  })
})
