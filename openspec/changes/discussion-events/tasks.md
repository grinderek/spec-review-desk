# Discussion slice

- [x] Map all conversation writers, including owner choices and Apply paths.
- [x] Add explicit discussion commands/events, replay and protected snapshot fields.
- [x] Journal reviewer session and minimal patch metadata.
- [x] Observe the complete review journal in existing contracts; add open/recovery product rules.
- [ ] Run npm test, typecheck, existing e2e and Desk self-review.
- [x] Manually verify invalid/error replies, full replay and absence of repeat effects in disposable repositories.

This slice does not complete all of S2. No owner approval is recorded by this checklist.

Initial checks on 2026-10-19: npm test passed 53 executions (40 contracts), empty Vitest suite
succeeded, typecheck passed. Disposable manual verification recovered ordered messages, resolved
status, reviewer session and invalid/error replies after removal of review.yaml; reads left model
audit, journal and Git HEAD unchanged. Snapshot thread edits and malformed missing-thread history
were refused explicitly. No real owner history was changed.

Final isolated browser/self-review verification remains pending: parallel S3 edits in the shared
checkout temporarily broke initiative module initialization and initiative run writes during these
checks. The first two browser workflows for discussions/decisions passed before that interference.
