# Approval workflow and single-format S1

## Process

| Actor and view | Command | Decision and events | Next view or effect |
| --- | --- | --- | --- |
| Owner sees current scenario | ApproveScenario | ScenarioApproved with current canonical hash, HEAD and time | Approved only while the recorded hash matches |
| Owner sees a scenario review | RevokeScenario | ScenarioReviewRemoved for an existing own entry | Pending; unknown key is a no-op |
| Owner requests a correction | RequestScenarioChanges | ScenarioChangesRequested with current hash and initial owner thread | Changes requested; thread written to YAML and question service invoked afterward |
| Owner sees a proposed phrase | ApprovePhrase / RevokePhrase | PhraseApproved with current hash / PhraseReviewRemoved for an existing own entry | Hash-bound phrase review; unknown revoke is a no-op |
| Owner sees a ready change | RecordChangeApproval | ChangeApprovalRecorded with current HEAD and time; refuse if readiness fails | Commit review.yaml and journal; return the actual Git commit |
| Owner sees an orphan entry | DropOrphanReview | Remove existing scenario/phrase entry | Orphan disappears; unknown key is a no-op |
| Owner chooses a valid target | ReattachOrphanReview | Remove old key then record the exact existing entry at target | Preserve status, hash, original commit and entry time; changed content remains pending |

Reattach verifies target existence and source entry; the same valid key is a no-op. A different
key always produces removal plus recording, even when target already has an identical entry.
Approve and request-changes always record their explicit decision, including when timestamps
coincide. Arbitrary keys use own-property lookup and safe own-property assignment.

## Application and persistence boundary

`server/approval-commands.ts` reads current facts, calls the pure decision, rechecks facts before
recording, and runs optional effects after recording and another facts check. All endpoints use
this path. The HTTP API and existing hashes remain unchanged. Commands receive the current
server contract; they do not claim it is the exact text previously displayed in the browser.

The canonical review scope lock covers reading history, facts, command decision, batch recording,
projection writing and the whole-change Git effect. In-process operations queue. Cooperating
WSL/Linux processes use an inherited-descriptor flock with a stable temp lock inode. Busy locks
return review_busy; flock is required. Independent changes have independent locks.

The single supported event envelope is version 2: UUID stream/event/command ids, sequence from 1,
time, origin approval-command (fixture only in disposable setup). The stream id remains stable.
Every batch compares the original journal byte hash, then atomically replaces the file with its
unchanged prefix and all new events before writing the approval projection. There is no v1
reader, import checkpoint, YAML import or snapshot-diff bridge. Unsupported journals and old
approval-only snapshots fail clearly. This change does not convert external workspaces.

`writeReview` may mutate only non-approval fields. The approval journal is authoritative for
scenario, phrase and whole-change entries. Domain entry time is preserved when reattaching;
ChangeApprovalRecorded retains its chosen time while envelope metadata is added.

Request-changes includes its initial thread in the event, then adds that thread once to mixed
YAML. Historical threads are not replayed over later discussion state. Discussions, decisions
and agent runs remain authoritative YAML in S1; losing YAML can lose those fields. S2 must choose
their recovery model separately. No complete event-sourced review is claimed here.

## Failures and limits

Replay projects approval state only. It never runs Git, question service, Codex or notifications.
Whole-change Git failures propagate as failed HTTP operations while the recorded approval remains
in the journal. A retry is a new owner command and can add a new event. Durable Git intent/result
reconciliation and exactly-once effects are outside S1. The response only reports a commit after
Git succeeds; recorded approval is not proof of that Git result.

A projection failure can occur after successful journal recording. Approval state recovers on
read; mixed YAML discussion state still depends on its snapshot. There is no atomic transaction
across journal, YAML and Git. A request-changes failure in that interval may leave its event but
not its thread; do not represent the event as full conversation recovery.

External editors, Git commands, noncooperating writers and separate host temp directories do
not share the lock. Source rechecks detect observed changes, not changes after the last read.
The byte CAS has the same boundary. Atomic rename prevents partial command batches; power-loss
durability is not promised. Journal rewrite cost grows with its history.

Old binaries cannot read the target format; rollback requires a reader that supports it. There
is no compatibility export. Real owner history is neither edited nor fabricated by this work.
OpenSpec/native package migration remains S6-S7 and is not part of S1.
