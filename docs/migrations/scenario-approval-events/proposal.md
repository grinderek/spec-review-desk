> Superseded for current implementation by [approval-command-events](../approval-command-events/design.md).
> This document records the first slice only. The owner's later instruction removes internal
> backward compatibility: v1 decoding, import checkpoints, snapshot diff bridges and identical
> timestamp approval no-ops described below are no longer implemented. All approval commands
> now use the single version 2 journal format. Do not restore the legacy path from this document.

# Explicit scenario approval commands

Start S1 of [the migration](../event-sourced-desk/design.md) with the existing scenario approve
and revoke workflow. Commands decide events directly from replayed approvals and current source
facts. The common store commits the events and then updates the approval view.

Public request bodies, responses, scenario keys, contract hashes and product rules stay the same.
The existing `features/scenario-approval.desk.yaml`, review actions and readiness contracts remain
the behavior agreement. This change introduces no new product contract and no duplicate spec
titles. It does not authorize agents to record owner approvals in this repository.

Other review operations retain the snapshot mutation bridge and share its writer with these
commands. Discussion, decision and execution fields remain authoritative YAML state.

See [design.md](design.md) for the workflow, compatibility and concurrency boundaries, and
[tasks.md](tasks.md) for verification.
