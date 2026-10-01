## Scope

The review corpus covers scenario and phrase approvals, requests for changes, whole-change approval
commits, orphan reassignment, readiness, public views and persistence compatibility. YAML DSL
coexists with Gherkin. A case table expresses variants of one rule; each row runs in a fresh repository.

## Execution

A domain adapter prepares prior events and environment conditions, then executes authenticated
HTTP commands against the real Hono app. Then compares exact new domain events, public responses,
subsequent GET observations and optional Git commit metadata. Generated ids and timestamps bind
from response fields. The question service uses a deterministic model transport for offline runs;
its validation and persistence remain real. UI behavior has a separate browser suite.

## Persistence

Approval history commits before review.yaml projection writing. Reading replays scenario, phrase
and whole-change approvals even if the projection is missing. A versioned import checkpoint preserves
old YAML approvals and scenario-only journals on their first approval-changing write. Import state
is distinct from newly emitted domain events. Invalid projections remain visible blocking errors.

Threads, decisions and agent runs retain YAML storage. A request-for-changes event includes the
initial owner thread, but subsequent discussion is not replayed from this approval journal.
Existing per-process locking serializes writes; multiple writers in different server processes
remain unsupported. Journal replacement cost grows with history. Git commits include the journal.

## Migration

The four legacy review test files are removed. Public behavior is mapped to the corpus in
`docs/method/review-migration.md`. Pure helper implementation checks are retired; discussion patch
and decision behavior retains its existing route coverage. Other domains migrate separately.
