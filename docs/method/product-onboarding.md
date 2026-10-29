# Connecting an existing product

Use the workspace configuration to declare repositories once under `repos`. An optional
`products` catalog groups them by product. Each product has a unique stable `name`, a display
`title`, a description, and named components. A repository component references a configured
repository by `repo`; a supporting directory uses `path` instead. Exactly one is required.
Paths resolve from `hubRoot`, which resolves from the configuration file's directory.
See `config.example.yaml` for the complete configuration shape.

The authenticated `GET /api/products` and the Products sidebar show the explicitly configured
checkouts, even before they have native changes. Each repository reports its full revision,
branch, number of local changes and linked worktrees, executable corpus count and parsing
errors, and any runner configured for that checkout. A supporting folder is not automatically
treated as a repository even when a parent folder contains `.git`. Missing components remain
visible with an unavailable state. Reading this overview does not mutate approval histories
or start a verification command.

Availability, executable rules, runner configuration, actual verification and owner approval
are different facts. The catalog does not declare a product verified. The existing runner
still belongs to one anchor checkout. Its optional `sources` list declares additional
Git checkout roots, with stable names and paths relative to hubRoot. Desk captures their
HEADs and working files in the same immutable manifest, checks them before dispatch and
acceptance, and invalidates the result when an input changes. Reruns retain their source
scope. The configured command owns the actual environment and cross-component operations.

For the Monitoring pilot, `/home/danila/protok/monitoring/spec-review.yaml` declares six Git
application repositories, a separate monitoring-specs checkout and one load generation folder
and uses port 4601. All eight components must be visible on `#/products/monitoring`.
Android is outside this catalog. The printed authenticated
launch URL establishes the local browser session. Build the Desk UI before launching the
server with the selected configuration; monitoring/README.md contains the exact command.

The next stage chooses one bounded business process. AI inventories real entry points,
data flow, existing checks and unknowns with file evidence. A developer confirms environment
setup, adapter actions and real observable results. AI drafts compact executable rules; the
owner decides intended business behavior. Discovered behavior is evidence, not an automatic
business decision. Applications can retain CRUD persistence while adapters model preparation
as event history. Adapters must observe actual public results rather than fabricate events
from the expected answer.

A combined run must bind every participating source revision and local input to its
immutable attempt and complete report. The Monitoring pilot declares backend, consumer and
frontend as additional inputs and verifies the actual running images against preparation
evidence. Registering several repositories alone does not establish that evidence.
Keep implementation handoff separate from business approval.

## Apply across a product

Apply resolves its workspace from the product containing the change repository. It includes
the current change worktree and every explicitly configured component of that product.
It does not grant access to the whole parent directory. Without a product, the workspace
contains the current checkout and the runner's declared source repositories. Missing
components or membership in several products block launch with an actionable error.

The change header exposes the component paths and available checks under "Доступ Apply к
продукту". The agent receives the same scope, repository instructions and verification
commands. Scoped file tools accept absolute component paths; `run_command` selects a
component by its `repository` name. Git commands cannot run in supporting directories.
Desk journals and projections remain owned by Desk. Existing local changes must be retained;
the agent stages explicit implementation paths and reports a separate commit per checkout.
Apply does not push or deploy.

The runner's verification command is available as `<repository-name>:verify` through
`run_check`. Optional `applyChecks` add exact named argv commands for environment preparation
or component checks, with a timeout in minutes (default 45, maximum 60). Runner
`applyAllowedTools` is optional; its default permits scoped file edits and local Git
inspection/commits. A read-only override blocks Apply before queuing an agent.
Commands retain execution identity markers and receive a reduced environment without
inherited API credentials. They run trusted repository code, so configure commands and
product membership only for repositories authorized to participate in implementation.

Apply reserves the participating Git checkouts before dispatch. Derived links in each
checkout locate the authoritative review journal; active or uncertain execution blocks
conflicting Desk work in any of those checkouts. Recovery observes the existing run and
does not repeat implementation. Terminal state releases a component only after its prior
execution processes are proven inactive.

## Describe an existing process in Desk

Use "Описать существующий процесс" in the sidebar or the product overview. Choose
the product, a process and its boundaries, the repository that will hold the rules,
and the repository components to inspect. By default Desk creates an independent
initiative worktree; the placement details also allow a registered existing worktree.
Creation recovery uses the same retained request and Git receipts as New feature.

Desk captures committed HEAD text sources from the selected repositories into an
immutable initiative input. It records repository names, full commits, file hashes
and line counts. Local uncommitted edits are outside that snapshot. Binary, hidden,
oversized, dependency/build, credential and detected-secret files are excluded and
the source overview reports excluded counts. A component may have at most 2500
candidate files, each at most 128 KiB; total captured content is limited to 12 MiB.
If the scope is too large, choose fewer components. Applications remain read-only.

The initiative's "Исследовать код" command uses the existing planner execution,
with code snapshots expanded into its immutable read-only room. The owner reviews
the findings and approves the proposed boundaries through the normal plan gate.
"Подготовить правила" then runs the author for a selected slice. It produces a
native proposal and implementation-references.yaml with one or more actual file
references for every executable rule. Desk validates rule identities, repository,
file and line ranges, and generates clickable source links in Proposal. Links open
the saved, authenticated code view, not the current mutable checkout. A valid link
establishes provenance; the owner still judges whether the rule describes the
intended behavior. Invalid or missing references prevent publishing that proposal.

The author cannot modify application code, create approvals, or install an adapter.
New phrases remain proposed; execution requires real adapter operations and their
inclusion in the runner's actual corpus. The existing card discussion, correction,
scenario approval and whole-package approval flows remain the owner's controls.
The "Исходники" tab exposes the captured scope and source files independently of
the generated narrative. Journals and immutable blobs retain process context and
sources across restarts; a later investigation gets a new explicit snapshot.
