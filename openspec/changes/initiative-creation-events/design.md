# Worktree creation request and accepted result

The configured repository worktree anchors one `.spec-review/worktree.events.jsonl` stream.
InitiativeCreationRequested stores its UUID, semantic request hash, complete canonical Git
identity, selected base commit, target path and branch, fixed initial stream/command identities,
timestamp, brief and immutable input blob references. Repeated content returns the existing
request; different content under that name is refused. Runtime blobs are captured once.

Creation acquires a lease keyed by the canonical Git common directory before the target Git
lease and creation scope lease. New branches are reserved in one Git reference transaction with
a private ownership metadata ref. A branch at the expected commit alone is not ownership proof.
Provisioning accepts only the recorded path, registered Git directory, common directory and
symbolic HEAD. Missing or contradictory proof becomes uncertain. No rollback, path replacement,
worktree repair or adoption of a foreign branch runs automatically.

After worktree proof, captured bytes are copied into a private content-addressed store inside the
target worktree. The initial initiative journal, derived YAML, brief, inputs and blobs become
exact GitEffect outputs. The intent lives in the anchor stream, avoiding a journal self-reference.
Input outputs use bounded source references; the small brief and metadata remain inline so the
existing 100 MiB input budget is preserved. The initial InitiativeCreated binds the creation UUID.

The commit receipt proves its expected parent, reserved effect trailer and complete planned tree.
Only InitiativeCreationCompleted releases the pending creation gate. Recovery can accept an
existing receipt or describe pending/uncertain work, but cannot create a branch, worktree, file or
commit. Explicit retry may resume known partial files and never repeats a completed creation.
The New Feature screen shows pending creation status with explicit retry and observation actions.

Creation requests and Git effect plans persist a kernel process birth boundary. Mutating Git
commands and their hooks inherit the durable creation/effect UUID plus any outer execution UUIDs.
Receipt acceptance and explicit retries require proof that these processes have exited, even when
Desk died during a pre/post-commit or post-checkout hook. Historical commit proof does not release
a still-live hook. This uses the common process scanner without a second Git execution journal. Layout paths are centralized for the subsequent native format cutover.
