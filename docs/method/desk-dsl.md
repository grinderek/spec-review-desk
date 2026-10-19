# Desk DSL v1: executable review contracts

The YAML DSL uses named events and commands. It coexists with Gherkin. The executable corpus is
`features/*.desk.yaml`; `openspec/changes/try-desk-dsl` contains the same contracts for owner review.

```yaml
version: 1
feature: Scenario review
scenarios:
  - id: approve-current-contract
    scenario: Approve the current scenario contract
    given:
      - ScenarioDiscovered: {}
    when:
      ApproveScenario: { key: $key }
    then:
      events:
        - ScenarioApproved: { key: $key, hash: $hash, commit: $head }
      response: { status: 200, body: { ok: true } }
```

Bindings use literal dotted response paths without variable interpolation. For generated fields
with ordinary property names, use `then.bind: { threadId: response.body.threadId }`, then `$threadId` in later assertions.
Bindings require nonempty strings and cannot overwrite a different previously bound value.

A scenario has a stable lowercase id, a readable title, prior event/environment facts, one command
and an explicit expected event list and response. Each fact is a single-key mapping with a mapping
payload. `events: []` expects no new domain events. Unknown structural fields, duplicate YAML keys,
aliases, duplicate ids and multiple commands are rejected. There are no arbitrary expressions or
embedded executable code.

## What belongs in a contract

Keep the owner corpus small: a scenario describes a product rule someone can read and approve.
Write standalone unit or technical integration tests only at the owner’s explicit request. Do not extend
the language or add cases to reproduce removed implementation checks.
The review corpus retains its 14 rules. Discussions, owner decisions, initiatives, research,
implementation, verification and agent usage add 24 core rules: 40 contracts / 53 executions across the app.
See [the application testing map](testing.md) for the repository verification policy.

## Case tables and observations

`cases` lists parameter mappings. Each row executes the same rule in a fresh repository. `$name`
substitutes a typed value when it occupies the entire string; embedded references interpolate
strings. Fact names and mapping keys can also use variables. Case tables appear as examples in Desk;
results show each row and aggregate the worst row status for the contract.

```yaml
cases:
  - { name: new phrase, extension: false }
  - { name: extended phrase, extension: true }
given:
  - ScenarioDiscovered: {}
  - PhraseProposed: { extension: $extension }
when:
  ApprovePhrase: { key: $phrase }
then:
  events:
    - PhraseApproved: { key: $phrase, hash: $phraseHash }
  response: { status: 200, body: { ok: true } }
  reads:
    - path: $change
      response:
        status: 200
        body: { phrases: [{ key: $phrase, effective: { status: approved } }] }
```

Each `then.reads` entry issues a GET and compares its response. Observations must not emit events.
Responses and event payloads match listed object fields recursively; arrays match length and order
exactly. Review-journal events match exact count, order and type. Response status is an HTTP number. Failures
identify the contract, case and field; empty or malformed corpora fail.

## The review adapter

`server/testing/desk-world.ts` composes the domain adapters around
`server/testing/review-world.ts`, which creates a clean Git repository, real Hono app, security
middleware, discovery, disk-backed review store and review routes for every execution. Commands
cover review, discussions and patches, owner decisions, planning, research, authored changes, Apply
and verification. Reads observe actual change, initiative, corpus and runner views. A domain adapter
is defined once per operation; expectations stay in the contracts.

Given facts prepare source contracts, phrases, prior approvals, discussions and decisions.
Approvals use the same serialized writer as production. Technical details use compiler checks and targeted manual inspection; standalone tests require an
explicit owner request. Vitest remains available with an empty suite. Fixture
bindings include `$key`, `$hash`, `$head`, `$at`, `$change`, `$phrase` and `$phraseHash`. Production
commands generate their own ids and times. The question service uses a deterministic model transport
while running real reply validation and persistence. Initiative and Apply workflows use the existing
fake Codex CLI and sandbox transport, with real protocol parsing, services, finishers, vetting and
Git writes. Local verification executes a real subprocess with a controlled workload. No live LLM
or Docker is required for this corpus.

`then.events` observes every new event in the selected review, initiative or verification journal. No events
are invented from expected state or transient event-bus notifications.

## Review persistence

`review.events.jsonl` stores explicit approvals, discussions, owner decisions, patch lifecycle and
Git effects. Approval assertions expose entry fields as key/hash/commit/at; other assertions expose
the event's domain payload directly. DiscussionOpened records the initial thread; replies append
complete messages; DiscussionResolved closes it. Reviewer session selection is recorded separately.
OwnerDecision events retain questions, choices, dismissals, attachment and confirmed recording.
Patch events distinguish request, pending/uncertain execution and verified completion. Resolving
messages retain the original scenario/choice bindings; reattachment cannot make an old patch record
an unrelated obligation.

The supported envelope is version 2 with stream/event/command UUIDs, sequence from 1, time and
origin approval-command, discussion-command, decision-command, patch-command or disposable fixture.
Unsupported history and snapshots without their required journal fail explicitly. There are no
imports, checkpoints or snapshot-diff bridges. Request-changes and scenario-choice commands record
their related discussion events in the same batch. Replies preserve validation failures and references.

The journal is atomically replaced before updating its YAML projection. Approvals, discussions,
decisions, patch lifecycle, Git effects and reviewer session recover after projection loss. Snapshot
writers cannot alter them. Only nonmigrated agent runs still require mixed YAML. Readers generate
the decision log from confirmed events even if decisions.md is absent. Initiative business state
uses its own journal and immutable content blobs; its run snapshot remains until S4.

Writers share a canonical per-scope queue, advisory flock on WSL/Linux and byte-version check.
A busy lock returns conflict; flock is required. External editors do not participate in the lock;
journal rewrite cost grows with history and power-loss durability is not promised. A failed YAML
write can follow a successful event commit. Replay never resumes model or Git work. Decision/patch
Git requests acquire the shared worktree lease before the scope lease. A verified receipt, including
its allowed paths and resulting blobs, is required for completion. Explicit retry can finish a known
pending effect; unknown drift is refused. See the [S2 design](../../openspec/changes/owner-decision-events/design.md)
for current limits and the remaining startup/agent execution recovery work.

## Review and run Desk itself

`then.stream` selects the event observation boundary explicitly: `review` (the default),
`initiative` or `verification`. Expectations compare the complete new event sequence in that one stream. There is
no invented global order across independent streams. An initiative owner decision observes its
review events; subsequent GET observations verify research permissions in initiative state.
Initiative contracts select `initiative` for brief, input, plan and domain events. Immutable
content blobs and the initiative journal restore the materialized brief and input files; reading
these views does not record business events or restart work.

```sh
npm run test:spec
npm run desk
```

`config.desk.yaml` discovers this repository and configures a local runner for `npm run test:spec`.
Run now executes the corpus and loads its per-contract/per-case results. Local runners execute the
configured argv on the host; configuration is trusted. Compose runners remain supported. Results
live in gitignored `.spec-review/`, with native Desk envelopes and support for Cucumber envelopes.

The UI displays YAML contracts, event/command summaries, approvals and diffs. Keys use file::id.
Hashes include canonical contract content and case tables: comments, indentation and mapping-key
order preserve approval; changed expectations require approval again. Corpus comparison uses the
same hash. See [the testing boundary](review-migration.md) for the verification policy. Browser workflows remain available. Live authoring through a Codex account is outside these
offline contracts.
