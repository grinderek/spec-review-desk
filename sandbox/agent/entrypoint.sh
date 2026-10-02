#!/bin/sh
set -eu
if [ "${DESK_CHATGPT_AUTH:-}" = 1 ]; then
  # Every attempt keeps its own sessions, but uses the same refreshable login.
  # The pinned CLI writes auth.json in place (including through a symlink).
  # Hold the volume's lock for the CLI lifetime so concurrent attempts cannot
  # consume the same rotating refresh token. Login/logout use this lock too.
  exec flock /opt/spec-review-auth/auth.lock sh -c '
    mkdir -p "$CODEX_HOME"
    ln -sf /opt/spec-review-auth/auth.json "$CODEX_HOME/auth.json"
    exec "$@"
  ' desk-auth "$@"
fi
exec "$@"
