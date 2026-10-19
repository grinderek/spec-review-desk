# Tasks

- [x] Journal run lifecycle and derive all run state from history.
- [x] Versioned input manifests, immutable rooms and safe receipt artifacts.
- [x] Retained attempt-specific Docker identity and inactivity checks.
- [x] Recovery, explicit stop/resume and idempotent domain finalization.
- [x] Planner/author Git intents, receipts and explicit effect retry.
- [x] Worktree admission for initiative start, dispatch, resume and finalization.
- [x] Owner contracts for recovery, uncertainty, resume, stop and preserved plan edits.
- [x] Targeted initiative corpus: 19 executions passed; compiler passed.
- [x] Manual hook failure/restart: no automatic Git/Codex repeat; explicit resume completes once.
- [ ] Complete remaining direct owner Git effects and creation coordination.
- [x] Combined final npm test: 88/88 executions, typecheck, self-review (73 contracts, 88 executions, 72 matching review contracts), full browser suite: 13/13.
- [x] Active author stop: terminal transport receipt can settle stopped after full inactivity proof even without a business artifact.
- [x] Detached followers and error handlers use independent lock context; test fixtures wait for actual fake start and stop owned workers before deleting artifacts.
- [ ] Harden invalid UTF-8/encoded artifact limits and retained browser/proxy/network cleanup in the next batch.
