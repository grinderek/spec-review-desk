# Developing Desk with owner-requested technical tests

Write or restore unit and technical integration tests only at the owner's explicit request.
Implementing a feature or fixing a bug does not implicitly authorize new tests. This policy is in
`AGENTS.md` and the Desk agent prompts. Do not reproduce deleted assertions in DSL, browser cases,
smoke scripts or adapters on your own initiative.

The previous 488 checks in 58 files remain deleted. Vitest, its configuration, isolated temporary
root, coverage support and dependencies remain available for future owner-requested tests.
The suite is currently empty; Vitest succeeds with `passWithNoTests`, without claiming test coverage.
The existing product corpus remains 37 contracts / 50 executions; no extra cases were added to
compensate for the deletion.

## Verification

- `npm test` runs product contracts and any owner-requested Vitest tests.
- `npm run test:technical` runs Vitest; `test:legacy` is its compatibility alias.
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

Approval events remain replayable. Other domains retain their YAML storage. Contract event assertions
refer to the approval journal; other state is observed through public views. All verification runs
use disposable fixture repositories and never forge owner approvals in the real repository.
