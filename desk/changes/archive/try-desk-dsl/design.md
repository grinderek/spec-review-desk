## Testing boundary

The DSL covers owner workflows and business gates: approvals, semantic changes, requests for
changes, readiness and orphan operations. Fourteen readable rules use small case tables for
meaningful variants. Write standalone unit or technical integration tests only at the owner’s explicit request. The old suite is removed;
do not extend the language or another verification script to reproduce it. Existing browser flows,
compiler checks and targeted manual verification remain.

## Execution

A shared fixture creates a fresh Git repository and real Hono app. The DSL adapter prepares prior
facts and executes one authenticated public command. Then checks exact new domain events, the
response and subsequent GET observations. Generated values bind from command responses. There is no separate technical assertion suite. The question service uses a deterministic
model transport while running real validation and persistence. UI behavior retains browser coverage.

## Persistence

Approval history commits before review.yaml projection writing. Reads replay scenario, phrase and
whole-change approvals after projection loss. A versioned import checkpoint preserves old YAML
approvals and scenario-only journals on their first approval-changing write. Import state is
distinct from new domain events. Invalid files remain visible errors.

Threads, decisions and agent runs retain YAML storage. A request-for-changes event includes the
initial owner thread; later discussion is not replayed from this approval journal. Per-process
locking serializes writes; multiple server processes writing one change remain unsupported.
Journal replacement cost grows with history. Approval commits include the journal.

## Coverage

Product contracts cover the primary workflows: 37 rules and 50 executions. `npm test` runs
this corpus and any owner-requested Vitest tests; `test:self` verifies execution through Desk. All 58 Vitest suite files (488 checks) and
unused helpers remain removed. Vitest configuration, dependencies, temporary-root setup and coverage
commands remain available for owner-requested tests; the suite is currently empty. Browser workflows and typecheck
remain. See `docs/method/testing.md` for verification limits.

## Application workflows

The review slice remains 14 rules. The complete primary workflow corpus adds 23 rules across
four domain files. A shared DeskWorld composes the real routes and services. Existing fake Codex
and sandbox transports provide deterministic replies and source output; actual finishers vet
and move changes, owner commands approve them, and Apply writes a matching implemented corpus.
Dependency availability is checked after prerequisite approval, while applied status additionally
requires a completed run, every implemented contract matching, and no corpus parse errors.
A successful run with absent scenarios no longer marks a slice applied. Research checks approved reading and search-only
choices. Verification uses a real local subprocess.

AGENTS.md and agent prompts allow standalone unit/technical integration tests only at the owner’s
explicit request and forbid recreating deleted assertions elsewhere on the agent’s own initiative. The DSL gains no syntax or scenarios from this removal.
Contract event assertions refer to the approval journal; other state is observed through public views.
