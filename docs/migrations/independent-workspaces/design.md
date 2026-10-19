## Configuration boundary

The application owns neutral defaults and a self-review profile. Each target workspace owns its
repository list, integration branch, runner commands, Compose overlays, credentials and routing
launcher. Existing configuration fields remain compatible.

CLI `--config` overrides `SPEC_REVIEW_CONFIG`, then the current directory's `config.yaml` is used.
Startup and agent authentication share this selection. Development inherits the environment
selection and proxies to the selected backend port. The explicit self-review profile stays pinned.

`hubRoot` defaults to the configuration directory. Repository and runner worktree paths resolve
from that root; Compose files, environment file and usage storage resolve from the config directory.
`initiativeBase` defaults to HEAD so any existing Git branch can be used.

## Migration and verification

The existing product profile and Compose overlay live in its hub's `tools/spec-review`, preserving
local path edits as equivalent relative paths and explicitly retaining `initiativeBase: staging`.
Existing hub credentials and usage remain in place. A launcher selects the independent Desk checkout.
No review approvals, decisions or initiative history are edited.

Verify with the existing product corpus, compiler, browser workflows, self-review runner and manual
launches using an external profile. Existing approved owner contracts remain unchanged.
