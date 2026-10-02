## Testing boundary

The DSL covers owner workflows and business gates: approvals, semantic changes, requests for
changes, readiness and orphan operations. Fourteen readable rules use small case tables for
meaningful variants. Source formats, migration, concurrency, corrupt state, invalid API input and
Git artifacts use ordinary TypeScript integration tests. Do not extend the language for those checks.

## Execution

A shared fixture creates a fresh Git repository and real Hono app. The DSL adapter prepares prior
facts and executes one authenticated public command. Then checks exact new domain events, the
response and subsequent GET observations. Generated values bind from command responses. Technical
tests use the same fixture with direct disk/HTTP assertions. The question service uses a deterministic
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

The old review route, readiness, store and change-view files are retired. Product rules live in
three DSL files; technical coverage lives in server/review.integration.test.ts. See
`docs/method/review-migration.md`. Other domains retain their tests. The Desk runner verifies
product contracts; npm test verifies both contracts and technical checks.

## Application workflows

The review slice remains 14 rules. The complete primary workflow corpus adds 23 rules across
four domain files. A shared DeskWorld composes the real routes and services. Existing fake Codex
and sandbox transports provide deterministic replies and source output; actual finishers vet
and move changes, owner commands approve them, and Apply writes a matching implemented corpus.
Dependency availability is checked after prerequisite approval, while applied status additionally
requires a completed run, every implemented contract matching, and no corpus parse errors.
A successful run with absent scenarios no longer marks a slice applied. Research checks approved reading and search-only
choices. Verification uses a real local subprocess.

Nine superseded product checks are retired; mixed tests keep their distinct technical assertions.
Parsers, security, process recovery, network permissions, serialization and UI/browser checks
remain. `docs/method/testing.md` maps this boundary across the app. Contract event assertions refer
to the approval journal; other state is observed through public views. The DSL gains no syntax.
