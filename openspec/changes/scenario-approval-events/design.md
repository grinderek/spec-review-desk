> Superseded for current implementation by [approval-command-events](../approval-command-events/design.md).
> This document records the first slice only. The owner's later instruction removes internal
> backward compatibility: v1 decoding, import checkpoints, snapshot diff bridges and identical
> timestamp approval no-ops described below are no longer implemented. All approval commands
> now use the single version 2 journal format. Do not restore the legacy path from this document.

# Scenario approval: process and first event-sourced slice

## Process

| Actor | Current view | Command | New event | Next view |
| --- | --- | --- | --- | --- |
| Owner | Current scenario text and effective review status | ApproveScenario(key) | ScenarioApproved(key, canonical hash, Git HEAD, time) | Approved when the current contract hash matches the recorded hash |
| Owner | Scenario review entry, including an orphan entry | RevokeScenario(key) | ScenarioReviewRemoved(key) when an entry exists | Pending, or absent from orphan reviews |

The existing HTTP routes receive only a key. Approval therefore concerns the current server
contract, with no claim that it is the version previously displayed on the owner's screen.
Revoke accepts an unknown key and returns success without an event. Approve returns unknown
scenario when the key is absent. Approving again records the new approval time; a completely
identical entry remains a no-op, matching the previous snapshot diff behavior.

Inputs are the replayed scenario entries, the current canonical contract hash, Git HEAD and
server time. Archived changes remain read-only. Invalid authoritative review YAML or journal
fails closed. Discovery, scenario parsing and Git errors do not produce an approval. Canonical
hashing, changed-since-approval and readiness semantics remain those of the existing contracts.

## Command and storage path

1. Resolve the writable change and validate the request body.
2. Acquire the shared review lock, read and validate legacy YAML and the complete event stream.
3. Replay approval state. Read the scenario hash and HEAD under the same review lock.
4. `decideScenarioReview` returns explicit events. It never compares two ReviewDoc snapshots.
5. Read source facts again immediately before commit; reject a changed hash or HEAD.
6. Compare the expected stream version (SHA-256 of its original bytes), then atomically replace
   the journal with the original prefix and one complete batch, including any import checkpoint.
7. Project the new history over the unchanged non-approval fields and replace review.yaml.
8. Return the existing response and publish the existing UI notification.

The journal is committed before the YAML projection. A failed projection write may mean the
command committed despite an HTTP error. The next read recovers approval state from the journal.
Revoke can be retried safely. Approve has no client command id and a retry may record another
approval timestamp; exactly-once delivery is not introduced in this slice.

## Compatibility and identity

Version 1 events and ReviewApprovalHistoryExtended checkpoints retain their decoding and replay
meaning. Existing journal bytes remain an unchanged prefix, including formatting and line endings.
The legacy snapshot mutation bridge remains for request-changes, orphan operations, phrase and
whole-change approvals. Both paths use the same journal commit function and review lock.

New scenario command events use a version 2 envelope. It adds a random stream UUID, ordinal
sequence across all journal records (including v1 and import), event UUID, command UUID, timestamp
and `origin: scenario-command`. The event payload and names remain compatible with the existing
approval observations. The first v2 event establishes stream identity in the journal itself;
later v2 events must retain that identity and match their ordinal position. A command id is its
causation id for this synchronous local operation; no cross-workflow correlation is claimed.
No actor identity is invented for historical events. A path-derived UI id is not a stream id.

Approval views replay through the production projector. YAML is still required and validated
because threads, decisions and runs have not migrated. Deleting only YAML approval fields can
recover them; deleting the whole YAML loses those other fields. A corrupt YAML is not silently
replaced. Replay does not execute Git, Codex or notifications. `then.events` continues to observe
only approval-journal events, excluding import checkpoints.

Before the first v2 write the old binary remains readable. Afterward rollback requires a reader
that understands v2, or a separately verified compatibility export with writers stopped and the
original journal preserved. Running the old v1-only binary directly is not a supported rollback.

## Concurrency and limits

The existing per-change review scope is the consistency boundary of this slice. This narrows the
larger migration plan's workspace-wide single writer: independent changes may be written at the
same time, while all review mutations of one change share one serialized writer. Direct writeReview
also acquires that lock. Initiative locking keeps its existing independent scope.

In-process callers queue by canonical real path. Between processes on WSL/Linux, the same scope
uses an advisory kernel flock. A child acquires it on a descriptor inherited from the parent;
the parent keeps that open file description until the mutation ends. Descriptor closure or
process exit releases the lock. Lock files live outside the repository in the host temp directory
and are never unlinked on release. A busy lock returns a clear review_busy conflict. A missing
flock utility fails closed. Reentrant access uses an active lease, so a delayed async descendant
cannot retain lock privileges after its originating operation finishes.

This supports cooperating writers on one Linux host sharing the same temp directory and file
system. It does not coordinate containers with separate temp directories, old binaries that
ignore the lock, external editors, Git commands or concurrent branches. The source double-read
detects observed changes; an edit after the final read remains possible. Hash-bound views still
make an approval pending if the contract changes afterward. Journal CAS detects observed byte
changes, not an uncooperative writer racing after CAS. Atomic rename prevents partial batches;
power-loss durability and a transaction across Git, journal and YAML are not promised.
