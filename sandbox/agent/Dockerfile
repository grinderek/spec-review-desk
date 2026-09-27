# Spec Review Desk agent sandbox (spec B §5): the claude CLI and nothing else — no version control, no extra
# shell tools. Built by `npm run agent:build`; the tag carries the pinned CLI version.
FROM node:22-slim
ARG CLAUDE_CODE_VERSION=2.1.280
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /work/in /work/out \
 && chown agent:agent /work/out
USER agent
WORKDIR /work/in
