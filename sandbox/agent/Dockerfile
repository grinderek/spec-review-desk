# syntax=docker/dockerfile:1
# Codex CLI with scoped Desk MCP tools. No model-generated shell commands are exposed.
ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}
ARG CODEX_VERSION=0.159.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /work/in /work/out /opt/spec-review \
 && chown agent:agent /work/out
COPY server/desk-tools.mjs /opt/spec-review/desk-tools.mjs
USER agent
WORKDIR /work/in
