# Spec Review Desk research browser (spike 2026-09-28): the Playwright MCP server over HTTP with headless
# Chromium, for pages that render with JavaScript. Built by `npm run agent:build`; the tag carries the
# pinned MCP version. The Desk starts it per research read phase on its own --internal network
# (sr-bnet-<run>), with every page request through its own proxy (sr-bproxy-<run>: HTTPS to the
# approved research domains only, never api.anthropic.com) — server/sandbox-args.ts: browserRunArgs.
# The base image is the official Playwright image of the repo's Playwright version (1.63.0), pinned by
# digest (the tag names the version, the digest the bytes); its browsers are Chromium 1243.
# @playwright/mcp 0.0.80 is built on Playwright 1.63 and uses exactly that Chromium; 0.0.81 and later
# want Chromium 1246 (Playwright 1.64), which this image does not carry.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && npm cache clean --force
# The image's non-root user (uid 1001).
USER pwuser
WORKDIR /home/pwuser
EXPOSE 8931
ENTRYPOINT ["playwright-mcp"]
