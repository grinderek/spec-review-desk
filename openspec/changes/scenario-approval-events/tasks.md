> Superseded for current implementation by [approval-command-events](../approval-command-events/design.md).
> This document records the first slice only. The owner's later instruction removes internal
> backward compatibility: v1 decoding, import checkpoints, snapshot diff bridges and identical
> timestamp approval no-ops described below are no longer implemented. All approval commands
> now use the single version 2 journal format. Do not restore the legacy path from this document.

# First scenario command slice

- [x] Map actor, view, command, event and next view for approve/revoke.
- [x] Preserve existing product contracts, public API and no-op semantics.
- [x] Decide explicit scenario events from replayed state and current input facts.
- [x] Share the serialized journal commit with the legacy snapshot mutation bridge.
- [x] Add byte-version checking, atomic batches and WSL/Linux process locking.
- [x] Decode old events and import checkpoints without rewriting historical bytes.
- [x] Document v2 identity, source revalidation, partial projection failure and rollback limits.
- [x] Run npm test and npm run typecheck.
- [x] Run the existing browser workflows.
- [x] Manually inspect legacy replay, projection recovery and competing writers in disposable workspaces.

No owner approval is recorded by this checklist. No standalone technical tests, extra browser
cases or replacement smoke suite are added.

Verification on 2026-10-19: npm test passed all 51 product executions; the empty technical suite
exited successfully. Typecheck passed. Existing npm run e2e passed all 13 workflows. A disposable
ReviewWorld showed an unchanged v1 journal prefix after v2 approve, replay after clearing YAML
approval fields with an existing thread retained, revoke, no-op unknown revoke, competing-process
lock refusal and successful reacquisition after release. No real owner history was changed.

Corpus, runner and self-review behavior were not changed, so test:self was not repeated for this
slice. Later approval commands remain on the compatibility bridge.
