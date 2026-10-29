# Developing Desk with owner-requested technical tests

Write or restore unit and technical integration tests only at the owner's explicit request.
Implementing a feature or fixing a bug does not implicitly authorize new tests. This policy is in
`AGENTS.md` and the Desk agent prompts. Do not reproduce deleted assertions in DSL, browser cases,
smoke scripts or adapters on your own initiative.

The previous 488 checks in 58 files remain deleted. Vitest, its configuration, isolated temporary
root, coverage support and dependencies remain available for future owner-requested tests.
The suite is currently empty; Vitest succeeds with `passWithNoTests`, without claiming test coverage.
Product contracts cover owner-visible rules. New contracts describe product behavior, rather than
reconstructing the deleted technical suite. The runner reports current contract and execution counts.

## Verification

- `npm test` runs product contracts and any owner-requested Vitest tests.
- `npm run test:technical` runs Vitest.
- `npm run coverage` collects coverage for owner-requested tests; the empty suite has no coverage.
- `npm run test:self` verifies matching proposed and implemented contracts, then executes the corpus
  through Desk's own authenticated local runner and checks every result row.
- `npm run typecheck` verifies application types; `npm run e2e` builds the UI and runs the existing
  browser workflows.
- Existing Codex and Docker authentication smoke commands remain available for targeted runtime
  verification. They are not a replacement collection of technical test cases.

Use compiler checks, existing product/browser flows and targeted manual inspection for technical
changes. Add a contract only when it expresses a meaningful product rule the owner needs to approve.
Do not add one for each parser branch or implementation detail. Adapters prepare facts and execute
public operations; they must not hide a second assertion suite.

## Scope and limits

Contracts cover review, discussions, owner decisions, initiative planning and slices, research
permissions, Apply and verification. Scripted Codex and sandbox transports make these offline
checks deterministic; they verify orchestration rather than live model quality.

The removed suite separately checked malformed input, compatibility, concurrency, path safety,
Git rollback, process recovery and helper/UI details. Those cases no longer have dedicated automated
coverage. The remaining product and browser flows do not claim equivalent coverage.

Approvals, discussions, owner decisions, patch lifecycle and decision/patch Git receipts replay from
review history. Initiative metadata, brief/input content, plans and permissions replay from its
journal and immutable blobs. Reviewer/Apply executions replay from review history, sandboxed
initiative runs from initiative history, and verification attempts/reports from their worktree
verification journal. Contracts select review, initiative or verification history explicitly and
compare the complete event delta; public GETs observe other views. Product fixtures use disposable
repositories. Self-review executes the actual repository's corpus through its local runner and
records verification evidence, without writing owner approvals. Worktree-journal contracts also
cover initiative creation. Replay rebuilds projections without starting external work; recovery
observes typed receipts and verified process/container identities. An uncertain outcome requires
explicit owner action and inactivity proof before a fresh attempt. Unsupported history fails
explicitly instead of importing snapshots.
