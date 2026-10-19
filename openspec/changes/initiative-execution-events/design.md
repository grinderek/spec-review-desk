# Durable initiative execution

InitiativeRunRequested retains the public run ID and a separate UUID execution identity. Common
ExecutionQueued/AttemptRequested/Observed/ReceiptAccepted/Settled/Uncertain facts live in the same
initiative stream through InitiativeExecutionRecorded. Explicit parameter and outcome events
retain research phases, actual reading domains, selected session, validation retry and notes.
Runs and executions are full projections; initiative YAML no longer supplies any run state.

Each attempt records HEAD, input source hash, initiative stream position, immutable brief/input
blob references, the plan hash, a hash of copied room files, routing and owner decisions. An
immutable input manifest and independent room/output directories live under the attempt ID.
Resume prepares a new input version. The worker verifies the manifest and room before launch.

The shared command transport starts an initiative sandbox worker. Production uses DockerSandbox;
the fixture injects its own provider. Provider configuration stores credential locations and auth
volume names, never credential values. The worker reads credentials at runtime and persists only
redacted logs and a typed safe result artifact. The shared transport seals that artifact in its
terminal receipt. Author outputs are scanned together and retained in that receipt for recovery.

Every container has an attempt-specific name and remains inspectable after exit. Before accepting
a receipt, Desk proves that wrapper processes, inherited-marker descendants and the sandbox are
inactive, allowing a short wrapper-exit grace period. A live or unknown process/container keeps
the execution uncertain. A durable stop marker also closes the race before sandbox launch.

Recovery never creates another attempt. A live worker is followed; a valid receipt can complete
domain projection; missing or unprovable outcomes become uncertain. Resume requires explicit
owner action, closed blocking decisions and inactive prior execution. It either finishes a known
Git intent or creates a new versioned attempt. Worktree admission is acquired before scope locks
to exclude Apply, verification, uncertain executions and unrelated pending Git work.

Finisher decisions have deterministic IDs derived from run and attempt identity. Research input
registration checks recorded history, including later accepted or discarded drafts, so recovery
does not resurrect a discarded input. Planner results correlate to their attempt and never
overwrite later owner edits. Completed run state restores after losing the YAML view.

Planner Git output includes an immutable `plans/<attempt>.yaml` proposal artifact; mutable run
fields therefore cannot invalidate a pending effect's hashed output. Author Git output consists
of its vetted received files. InitiativeRunGitRequested stores the exact plan before execution;
InitiativeRunGitCompleted records only a verified receipt. Recovery reconciles these effects;
only an explicit owner resume may finish known partial application. Author decisions and slice
association register idempotently after its commit is proven. Pending output is not deleted or
rolled back blindly. Abandoning an unconfirmed Git effect is refused.

The runtime retains input manifests, rooms, safe logs and receipts. Terminal container resources
are cleaned only after domain finalization. Inputs have the existing upload limits; received
author output additionally fits the shared receipt and Git effect limits. Unsupported output
fails visibly. No exactly-once guarantee is made for external execution; uncertain outcomes remain
owner-visible instead of being converted into success or retried automatically.
