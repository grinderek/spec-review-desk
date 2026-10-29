# Event Sourcing and native Desk migration verification

S2-S7 are implemented. Owner approvals were never written in the actual repository.

The combined native checkpoint passed `npm test` with 108 executions, `npm run typecheck`,
`npm run test:self` with 89 corpus contracts / 108 executions / 88 matching review contracts,
and all 13 existing browser workflows. Vitest remains empty and succeeds without claiming
technical test coverage. Product tests use scripted Codex and sandbox transports with actual
HTTP handlers, domain writers, detached local workers and Git operations in disposable repos.

A complete public native workflow passed with PATH restricted to git/node/flock/getconf:
initiative creation, planning, owner plan approval, author output installation, scenario and
whole-change approval, Apply delivery, matching corpus and source-bound verification.
OpenSpec and its fake validator were absent. Restart preserved accepted receipts without a
new Codex call or commit; source changes made the former result stale.

Targeted checks covered ordered historical replay, duplicate IDs, unknown fields/versions,
lost/stale/corrupt generated views, nested stable identities and title renaming. A real Gherkin
compiler produced four outline cases in two same-basename files; the result consumer accepted
canonical IDs and refused missing-ID and incomplete reports. Report failure probes covered
factory/Given/When/Then/GET/cleanup failures, one command execution, immutable observations,
and preservation of the final history when a GET unexpectedly appended an event.

Real Docker checks covered process/container disagreement, orphan containers, explicit stop,
classified and abandoned cleanup, restart policies, label mismatch and no forced deletion of
live work. Real Git hooks surviving Desk termination were detected by their own and outer
execution IDs before receipt acceptance or retry. Captured input checks covered 100 MiB unique
inputs, 200 MiB materialized blob/view copies, and private umask with canonical Git modes.

Native package paths fail closed for namespace/scope/metadata symlinks or special files.
Missing initiative history with an existing snapshot blocks admission. The former internal
layout, title joins, CLI setting and validator are removed. Historical research remains under
`docs/migrations`; current executable packages are under `desk/changes`.
