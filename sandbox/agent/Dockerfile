# syntax=docker/dockerfile:1
# Codex CLI with scoped Desk MCP tools. No model-generated shell commands are exposed.
ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}
ARG CODEX_VERSION=0.159.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /work/in /work/out /opt/spec-review /opt/spec-review-auth \
 && chown agent:agent /work/out /opt/spec-review-auth \
 && chmod 700 /opt/spec-review-auth
COPY server/desk-tools.mjs /opt/spec-review/desk-tools.mjs
COPY --chmod=755 sandbox/agent/entrypoint.sh /opt/spec-review/entrypoint.sh
ENTRYPOINT ["/opt/spec-review/entrypoint.sh"]
USER agent
WORKDIR /work/in
