# Decisions, patches and recorded Git effects

OwnerDecisionRaised, OwnerDecisionChosen, OwnerDecisionDismissed, OwnerDecisionReattached and
OwnerDecisionRecorded project the decision list from review.events.jsonl. Owner and agent inputs
use the same explicit decision path. The generic YAML writer cannot modify these fields.
Scenario choice and the resulting owner discussion message are recorded in one command batch.
Whole-scope decisions remain decided until a confirmed commit records them. Scenario decisions
remain decided until a confirmed resolving patch records them.

PatchRejected and PatchRechecked cover owner review actions. PatchApplicationRequested associates
a patch with one Git intent and shows applying. GitEffectCompleted and PatchApplied are written
together with any OwnerDecisionRecorded events. Failure or uncertain execution records the observed
state and preserves files for inspection. The implementation does not reverse a patch over possibly
changed files. An unsettled effect blocks readiness and prevents conflicting scope effects.
Decisions involved in an unsettled effect cannot be dismissed or reattached. Resolving messages retain
the original scenario scope and exact owner choice from their prompt. Applying an older patch after
reattachment fails before intent or file effects; completion records only matching bindings.

GitEffectRequested stores a UUID, purpose, full parent HEAD, planned file paths, original hashes
and modes, complete resulting bytes, permitted additional scope file names and the commit message. The helper supports regular files
0644/0755, up to 100 outputs, 4 MiB per file and 16 MiB total inline content. Patch output is prepared
in a disposable preview; its input hashes and modes must still match the actual effect plan.
Paths, symlinks, nested repositories and unsupported modes are checked before managed writes.

The application acquires a common worktree Git lease before the review scope lease, records the
intent, checks inputs again, materializes outputs and creates a commit with Desk-Effect trailer.
The receipt verifies one exact commit, its full SHA, parent, message and output blobs/modes. It
preserves unrelated staged files and rejects receipts containing unplanned paths, including paths added by Git hooks. Scope journal/view files are additional commit paths; the journal
does not contain its own hash or future commit SHA. Completion necessarily follows that commit.

Reconciliation only observes. It reports completed, not_started, pending or uncertain from available
evidence. Explicit HTTP retry may finish known before/after files of the same pending effect; it
never creates another owner choice. Unknown drift refuses execution. Replay never invokes Git,
models or notifications. Journal batches use the existing CAS and atomic replacement protocol;
this is process-crash recovery, not a power-loss or distributed transaction guarantee.

decisions.md is a readable projection of confirmed whole-scope choices. Public GET reconstructs
the log from events even if that file and review.yaml are lost. The next explicit recording command
rebuilds its required view files. Automatic startup effect reconciliation and worktree-wide pending
effect coordination across different scopes remain S4 work. Approval and initiative Git effects
still use their earlier transport until that stage.

Initiative choices use the review journal in the initiative directory under its outer scope lease.
A confirmed reading choice is correlated with an idempotent ResearchDomainsGranted event in the
initiative journal. Repeating the owner command repairs a missing grant using the same decision
and commit. The two journals and Git do not form an atomic transaction.

The product rules cover successful recording, choice-to-discussion, resolving patch confirmation,
dismissal, preserved choice on Git failure, explicit retry, decision-log recovery and unconfirmed
patch recovery. Existing IDs are retained; new rules use stable IDs. No real owner approvals or
their history are changed by this implementation.
