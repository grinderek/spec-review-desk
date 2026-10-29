# Journal recovery slice

- [x] Remove review YAML authority when supported history exists.
- [x] Apply review events in one ordered historical pass.
- [x] Reject duplicate review event UUIDs.
- [x] Separate writer preparation from exact persisted record decoding.
- [x] Reject unknown nested fields instead of defaulting renamed business facts.
- [x] Propose owner recovery contract for lost, stale and malformed review views.
- [x] Run coordinated corpus, self-review and browser checks after native integration.

Native integration: npm test 108/108; typecheck; self-review 89 contracts / 108 executions / 88 matching reviewed contracts; browser checks 13/13. Single-execution trace failure/cleanup probes and ordered-prefix replay passed targeted inspection.
