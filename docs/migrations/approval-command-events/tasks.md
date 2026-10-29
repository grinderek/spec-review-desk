# S1 completion

- [x] Inspect the previous scenario slice and map all remaining approval operations.
- [x] Decide all events explicitly from replayed state and source facts.
- [x] Route all approval endpoints through the same serialized writer and source checks.
- [x] Remove v1 decoding, imports, snapshot diffs and identical-timestamp no-ops per owner instruction.
- [x] Preserve existing hash, readiness, orphan entry and public response rules.
- [x] Feed existing Given approvals through explicit prior history in disposable fixtures.
- [x] Document mixed YAML, partial failure, Git effect and rollback boundaries.
- [x] Update the migration plan and mark the first slice as superseded.
- [x] Run npm test (51 product executions, empty technical suite) and npm run typecheck.
- [x] Run existing browser workflows (13 passed) and Desk self-review (38 contracts / 51 executions / 37 matching review contracts).
- [x] Manually verify approval workflows and recovery in disposable workspaces.

No owner approval is recorded by this checklist. No standalone technical suite or new browser
collection is added. The existing product contracts retain their stable ids and expectations.

Verification on 2026-10-19: npm test passed all 51 executions; Vitest found no standalone tests
and succeeded. Typecheck passed. Existing e2e passed all 13 workflows in 2.7 minutes. Self-review
passed through the authenticated local runner, including every case result.

Disposable manual inspection exercised request-changes with initial owner thread and agent reply,
phrase approve/revoke, readiness refusal, whole-change Git success with both review files, and a
Git hook failure that retained the recorded event. Orphan reattach preserved the complete entry;
unknown and prototype-like keys and same-key reattach emitted no events. Clearing only YAML
approval fields recovered the same approval entry; a version 1 journal was explicitly refused.
The fixture was removed afterward. No real owner history was changed. No new test suite was added.
