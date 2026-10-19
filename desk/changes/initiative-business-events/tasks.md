# Tasks

- [x] Explicit initiative commands, events, replay and serialized CAS storage.
- [x] Immutable content blobs and derived brief/input restoration.
- [x] Migrate creation, brief edits, input lifecycle, domains, plans and slice associations.
- [x] Keep run-only mixed writes and reject business snapshot mutations.
- [x] Select initiative event observation in executable contracts.
- [x] Manually verify view loss, retained discarded content, grant retry, CAS and legacy rejection.
- [x] Complete combined corpus, compiler, browser and self-review checks after S2 integration.
- [x] Root review and checkpoint with the shared S2 decision integration.

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
