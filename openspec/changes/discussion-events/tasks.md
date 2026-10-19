# Discussion slice

- [x] Map all conversation writers, including owner choices and Apply paths.
- [x] Add explicit discussion commands/events, replay and protected snapshot fields.
- [x] Journal reviewer session and minimal patch metadata.
- [x] Observe the complete review journal in existing contracts; add open/recovery product rules.
- [x] Run npm test, typecheck, existing e2e and Desk self-review.
- [x] Manually verify invalid/error replies, full replay and absence of repeat effects in disposable repositories.

This slice does not complete all of S2. No owner approval is recorded by this checklist.

Initial checks on 2026-10-19: npm test passed 53 executions (40 contracts), empty Vitest suite
succeeded, typecheck passed. Disposable manual verification recovered ordered messages, resolved
status, reviewer session and invalid/error replies after removal of review.yaml; reads left model
audit, journal and Git HEAD unchanged. Snapshot thread edits and malformed missing-thread history
were refused explicitly. No real owner history was changed.

Final isolated verification of commit 00b24b3 passed: npm test 53 executions, typecheck,
13 browser checks and Desk self-review (40 corpus contracts, 53 executions, 39 matching review
contracts). The isolated checkout avoided unrelated intermediate S3 changes in the shared tree.
The following owner-decision-events slice replaces its temporary generic patch metadata event.
