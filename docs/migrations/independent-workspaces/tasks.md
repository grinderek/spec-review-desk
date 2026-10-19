- [x] Separate neutral application configuration from the existing product profile.
- [x] Share explicit and environment configuration selection between server and auth commands.
- [x] Remove product branch, UI example and Compose assumptions from the application.
- [x] Document single-repo and multi-repo configuration and optional runners.
- [x] Run compiler, product corpus, self-review, existing browser workflows and manual workspace launches.

Verification: typecheck and all 51 corpus executions pass. All 13 existing browser workflows pass
with the fixture started separately because WSL stalls on the initial unused-port probe. Manual
HTTP launch of an external project on a `topic` branch discovers it, proposes HEAD, serves the UI
and uses the selected backend port in development. The migrated hub profile resolves its existing
repositories and Compose files correctly.

`test:self` derives expected runner keys, totals and case rows from the entire executable DSL corpus,
including agent usage, and separately checks that the self-review change's contracts match it.
Approved contracts and approval history remain unchanged.
