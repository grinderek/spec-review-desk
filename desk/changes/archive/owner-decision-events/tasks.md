# Remaining S2

- [x] Replace decision snapshot writes with explicit commands, events and replay.
- [x] Record choice and scenario discussion in one review batch.
- [x] Project the readable decision log from recorded history.
- [x] Replace generic patch updates with named lifecycle events.
- [x] Persist Git intents and verify receipts before decision/patch completion.
- [x] Preserve pending effects, add explicit retry and refuse unknown drift.
- [x] Update executable contracts and recovery fixtures without legacy import.
- [x] Finish combined typecheck, corpus, self-review and browser verification.
- [x] Complete final review of effect receipt integration and checkpoint changes.

The first discussion slice is recorded separately in discussion-events. S4-S7 remain open.
This checklist does not record an owner approval.

Verified on 2026-10-19 in the shared final checkout: npm test passed 61 executions, empty Vitest
suite succeeded, typecheck passed, all 13 existing browser checks passed. Desk self-review passed
48 corpus contracts, 61 executions and 47 matching review contracts through its authenticated
runner. No real owner history files were created or changed.

Disposable manual checks covered pending decision/patch Git failures, projection loss, explicit
resume, idempotent repeated completion, one choice/one commit, refusing decision changes during a
pending effect, original decision/patch bindings, unexpected hook paths, preserved unrelated staged
files, safe paths/modes, initiative replay/content recovery, retained discarded blobs, grant retry,
CAS, no-final-LF append and missing/corrupt blob rejection before append. These are targeted checks;
they do not claim the coverage of the deleted technical suite. S4-S7 are still open.
