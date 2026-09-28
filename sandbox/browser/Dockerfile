# Spec Review Desk research browser (spike 2026-09-28): the Playwright MCP server over HTTP with headless
# Chromium, for pages that render with JavaScript. Built by `npm run agent:build`; the tag carries the
# pinned MCP version. The Desk starts it per research read phase on the run's --internal network with
# every page request through the run's egress proxy (server/sandbox-args.ts: browserRunArgs).
# The base image is the official Playwright image of the repo's Playwright version (1.63.0); its
# browsers are Chromium 1243. @playwright/mcp 0.0.80 is built on Playwright 1.63 and uses exactly that
# Chromium; 0.0.81 and later want Chromium 1246 (Playwright 1.64), which this image does not carry.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && npm cache clean --force
# The image's non-root user (uid 1001).
USER pwuser
WORKDIR /home/pwuser
EXPOSE 8931
ENTRYPOINT ["playwright-mcp"]
