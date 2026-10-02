# Developing Desk through product contracts

The executable corpus covers the primary application workflows. The owner reviews 37 rules,
with 50 isolated executions. It is intentionally not an exhaustive translation of implementation
tests. New behavior follows this boundary across the application; there is no requirement to
eliminate every function-level test.

| Product area | Owner contracts | Technical checks retained |
| --- | --- | --- |
| Review | Scenario/phrase approval and revocation, semantic changes, change approval, orphans, readiness | Import compatibility, projection replay, concurrent writes, Unicode keys, malformed state, archived requests, Git artifacts |
| Discussions | Answer and follow-up, resolution, committed correction requiring renewed approval | Real Codex permission policy and session transport, missing sessions, timeout, stale/unsafe patches, commit rollback |
| Decisions | Change choice, scenario choice, completion by committed resolving patch, dismissal | Invalid options, closed/orphan references, reply context, commit failure, decision-log parsing and serialization |
| Initiatives | Create/revise brief, planner draft, approve plan, blocking questions, propose slices, prerequisite approval | Multipart/file boundaries, stable ids, graph validation, worktree/Git failures, concurrent authors, locked plan edits |
| Research | Accept drafts, resume with approved reading or search-only permission | Domain normalization, browser/network capabilities, secret redaction, provenance, collisions, recovery and retries |
| Implementation | Recorded/current approval, reviewed authored slice, owner-choice resume, drift correction | Process reservations, stop/restart recovery, attempt log offsets, sandbox capabilities, output validation, unique ids |
| Verification | Passing/failing results through the real local runner | Compose transport, batching/debounce, malformed envelopes, result recovery and per-row aggregation |
| UI and infrastructure | Browser flows demonstrate the presented workflows | Rendering/diffs, refresh/event-stream lifetimes, configuration, parsers, path confinement and secret handling |

Nine duplicate product checks were removed from Apply, initiative creation/statuses, slice-plan
helpers and route tests. Mixed tests were narrowed to their distinct CLI, permission, Git artifact
or invalid-input assertions. The missing-corpus regression also has disk/API checks for removed contracts and malformed
approved or implemented files in `server/implementation.integration.test.ts`.
Technical regressions remain covered; retaining those boundaries
alongside a product workflow is intentional, not a second normative behavior corpus.

`npm test` runs product contracts and all TypeScript checks. `npm run test:technical` runs the latter;
`test:legacy` is a compatibility alias. Run typecheck and browser checks for relevant changes.
The local Desk runner executes the owner corpus. Passing it alone does not claim browser or
technical verification. `npm run test:self` checks matching proposed/executable contracts and
authenticated execution through the real Desk runner, including every case result.

The contract adapter uses real authenticated HTTP, disk, Git, services and reply validators.
External Codex and sandbox transports are scripted. One workflow runs from an actual planner
reply through author output vetting, owner review, Apply and corpus matching; another restores a
drifted corpus. A missing implemented scenario keeps its slice approved, rather than applied,
even if the agent reports success. These validate application orchestration, not the quality of live agent code.

Approval events remain replayable. Discussion, decision and initiative state keeps its existing
YAML storage. Contract event assertions refer to the approval journal; other domains observe their
persisted public views. No generated approval is forged in the real repository: all command
execution is isolated in disposable fixture repositories.
