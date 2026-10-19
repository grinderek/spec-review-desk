# Request, attempt, receipt and review outcome

ExecutionQueued records the durable request, target thread and owner message boundary. An initial
Apply request and its attempt are one journal batch. Reviewer queues accompany the discussion or
owner decision command that created them. ExecutionAttemptRequested records a fresh UUID, cause,
full HEAD, source fingerprint, agent routing, session, permissions and complete prompt/rules snapshot.
Resume, validation retry and missing-session fallback are separate attempts of one request.

The shared local worker consumes a typed runtime intent. Its process identity includes PID, Linux
boot identity, process start ticks and attempt marker. It survives Desk exit and atomically publishes
a bounded, validated terminal receipt before ending. Runtime artifacts are stored beneath
.spec-review/executions/<attempt-id>; they are transport evidence, not another business journal.
Receipts and streaming logs mask credentials. The streaming log does not retain raw structured
JSON fragments or the structured result. The typed receipt retains the bounded agent result.

ExecutionReceiptAccepted and the resulting discussion answer, raised owner decisions and final
ExecutionSettled are one scope batch. An already accepted receipt cannot create another answer or
decision. A validation retry accepts the prior receipt and requests a new attempt in that same
batch. Generic YAML mutation cannot change execution or Apply state. Apply views are derived from
execution events and recover when review.yaml is removed.

Replay only projects. A separate recovery coordinator inspects receipts and verified processes.
It accepts a proved terminal result, follows a proved live process, or records ExecutionUncertain.
It never dispatches an ambiguous request automatically. Explicit continuation uses a new attempt,
verifies the previous attempt is inactive, and checks current gates. ExecutionStopRequested is
recorded before signaling a verified execution process; its intent survives server restart.

Dispatch admission takes the shared worktree Git lease before the scope lease. It checks durable
active execution state and current source facts before spawn. No scope lease is held during the
full agent execution. Review patch/decision commits reject active or uncertain Apply executions.
The shared admission scan also reads initiative and verification history without taking scope
locks. Apply and verification require exclusive execution. Reviewer and initiative attempts retain
their snapshot semantics and final source checks, but refuse active Apply/verification, uncertain
work and pending Git effects. Git writers refuse active Apply/verification, uncertain work and
other pending effects. A continuation excludes only its own execution UUID or exact effect UUID.

Owner change approval records ChangeApprovalRecorded and a GitEffectRequested intent together.
The intent names the review journal and projection as commit extras without hashing its own journal.
Git receipt verification proves the expected parent, reserved effect trailer and allowed paths.
An explicit retry reuses the intent and never repeats owner approval. Startup only reconciles an
existing commit; a changed source cannot silently turn an old request into another approval.
Apply start and continuation require the latest approval effect to have an accepted commit for
the current source identity. A failed approval commit retains authorization but does not admit
implementation. Other safely failed Git effects do not become globally pending work.

Review receipt acceptance also proves the wrapper and inherited-marker descendants are inactive.
A receipt from a process with surviving children retains uncertainty and the lifetime gate.
The existing Git effect helper remains the source of Git receipt semantics.

The observation boundary remains all new events in the selected stream. Existing discussion,
approval, decision and implementation contracts explicitly list the new lifecycle facts. New
owner rules cover one recovered answer, repeated recovery, uncertainty, blocked implementation,
explicit continuation and stop/resume. Transport behavior is checked in disposable workspaces.
