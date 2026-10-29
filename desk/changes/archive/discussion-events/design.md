# Discussion process and recovery

| Actor and view | Command | Events | Next view or effect |
| --- | --- | --- | --- |
| Owner sees a contract | OpenDiscussion | DiscussionOpened | Open thread, then question service |
| Owner follows up | ReplyToDiscussion | DiscussionOwnerReplied | Open conversation, then question or Apply resume |
| Question service validates a reply | AgentReply | DiscussionAgentReplied | Answered if valid; open with invalid/error details otherwise |
| Owner closes conversation | ResolveDiscussion | DiscussionResolved | Resolved thread; repeating resolve is a no-op |
| Question service selects a session | SetReviewAgentSession | ReviewAgentSessionSet | Resume context survives projection loss |
| Patch operation records its result | UpdateDiscussionPatch | DiscussionPatchUpdated | Current patch state/files/error/commit survive replay |

`decideDiscussion` decides explicit events from replayed state. All commands use the same canonical
scope queue, advisory flock, expected journal byte version and complete atomic batch as approvals.
Request-changes records ScenarioChangesRequested and DiscussionOpened in one batch. Scenario choices
record their conversation in the same write as their still-mixed decision state. Apply resume and
completion/failure paths journal their messages, while Apply run bookkeeping remains mixed YAML.

The writer forbids snapshot writes to approvals, threads and reviewer session. Replay replaces
those fields entirely, reconstructing ordered messages including decision references, validation
failures, patch payloads and close status. Reading never calls Codex, Git or notifications. The
current format remains version 2 with discussion-command origin in addition to approval-command
and disposable fixture. Legacy embedded threads are unsupported; no import or compatibility bridge.

Patch metadata must be journaled to prevent a mixed-YAML loophole inside replayed messages. This
is the minimum needed for conversation recovery, not durable intent/result reconciliation of Git
effects. Current patch Git rollback semantics are retained; events already recorded are not erased.
The next slice handles decisions and durable patch effects separately. Losing mixed YAML can still
lose decisions, runs and initiative state. Replay alone does not resume pending model work.

Events commit before the derived YAML view. Projection-write failure can therefore report an error
after durable recording; a subsequent read restores discussion state. Atomic journal replacement
is not a power-loss durability promise. The history file grows with each batch. Uncooperating
external writers do not share flock. No real owner review history was changed or approved.
