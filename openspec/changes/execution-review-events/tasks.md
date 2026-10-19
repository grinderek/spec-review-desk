# First S4 slice

- [x] Record durable question requests together with discussion commands.
- [x] Record immutable attempt input before local dispatch.
- [x] Retain terminal evidence in a detached typed local worker.
- [x] Accept receipts and review consequences in one idempotent scope batch.
- [x] Project Apply state from execution events and protect migrated snapshot fields.
- [x] Share Apply continuation gates and persist stop intent before signaling.
- [x] Add explicit uncertain state, recovery and continuation to API/UI.
- [x] Update meaningful owner contracts and prior-history fixtures.
- [x] Verify restart, receipt idempotency, process identity, stop/resume and conflict admission.
- [x] Pass npm test, typecheck, existing browser checks and self-review.
- [ ] Root review and separate stage commit.

Initiative execution, verification execution and S5-S7 remain separate slices. Shared worktree
admission and durable approval completion were added after the isolated reviewer/Apply baseline.
This task list is not owner approval history.

Verification on 2026-10-19 used a disposable worktree based on e26a53a with the complete
reviewer/Apply slice and the shared execution transport. It excluded the concurrent initiative
and verification migrations. npm test passed all 68 product executions, typecheck passed,
the existing browser suite passed all 13 checks, and test:self passed with 55 corpus contracts,
68 executions and 54 matching review contracts. Agent usage remains an unreviewed corpus contract.

Targeted manual verification also covered a real Desk process exit followed by receipt recovery
with one CLI invocation and one answer, repeated recovery with no new events, explicit continuation
of an uncertain question, verified Apply stop/resume, and three concurrent queued requests producing
three answers with three CLI invocations. The shared transport was separately checked for verified
stop, timeout and orphan detection. The final combined S4 integration still needs root verification.

Follow-up targeted verification passed seven approval executions: existing ready/unready approval,
unchanged repeat, rejected commit with retained intent, explicit retry without another approval,
receipt recovery after commit, and repeated recovery. Typecheck passed after the shared admission
and durable approval additions. Their combined corpus/browser/self verification remains pending.
An additional real-process check forked a detached child, returned a valid terminal receipt and
proved that no review consequence was accepted: the execution remained uncertain and all five
admission operations refused conflicting work. Verified stop cleaned up that inherited-marker child.
The approval-specific Apply gate then passed its owner rule: a safely rejected approval commit
retains intent but refuses implementation until committed. Targeted approval verification passed
eight executions with this addition, and typecheck passed.

## Combined core checkpoint

- [x] npm test: 88 executions passed; empty Vitest suite succeeds.
- [x] Typecheck and Desk self-review: 73 corpus contracts, 88 executions, 72 matching review contracts.
- [x] Final full browser suite: 13/13 after stop, detached-lock and cache-loss scanner fixes.
- [x] Manual receipts: no repeat after restart; surviving child and missing runtime directory retain the lifetime gate.
- [ ] Remaining initiative owner Git effects, creation coordination and cleanup are separate unfinished S4 work.
