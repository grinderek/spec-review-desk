# Developing Desk without a standalone technical test suite

Do not write unit or technical integration tests for this repository. This explicit policy is in
`AGENTS.md` and in the Desk agent prompts. Do not restore Vitest, add another technical test framework,
or reproduce deleted assertions in DSL, browser cases, smoke scripts or contract adapters.

The complete Vitest suite has been removed: 488 checks in 58 files, its configuration, coverage
commands and dependencies, and unused suite helpers. There is no replacement technical suite.
The existing product corpus remains 37 contracts / 50 executions; no extra cases were added to
compensate for the deletion.

## Verification

- `npm test` runs only the product contracts through real authenticated routes and workflow services.
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
