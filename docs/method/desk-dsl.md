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

`then.events` observes every new event in the review journal, including discussions, patch
metadata and reviewer session selection. Other domains still use their public persisted views.
No events are invented from expected state or transient event-bus notifications.

## Review persistence

`review.events.jsonl` stores explicit approval and discussion events. Approval assertions expose
entry fields as key/hash/commit/at; other assertions expose the event's domain payload directly.
DiscussionOpened records the initial thread; owner/agent replies append complete messages;
DiscussionResolved closes the thread. DiscussionPatchUpdated records the current patch metadata,
and ReviewAgentSessionSet preserves the reviewer session. Replay never executes external effects.

The supported envelope is version 2 with stream/event/command UUIDs, sequence from 1, time and
origin approval-command, discussion-command or disposable fixture. Legacy embedded threads,
unsupported history and snapshots without their required journal fail explicitly. No imports,
checkpoints or snapshot-diff bridges exist. A request-changes command records approval and initial
discussion in the same batch. Agent replies preserve validation failures and decision references.

The complete journal is atomically replaced before updating its YAML projection. Approvals,
threads, patch metadata and reviewer session recover on read after projection loss; snapshot
writers cannot alter them. Decisions and agent runs still require their mixed YAML snapshot.
Writers share a canonical per-scope queue, advisory flock on WSL/Linux and byte-version check.
A busy lock returns conflict; flock is required. External editors do not participate in the lock;
journal rewrite cost grows with history and power-loss durability is not promised. A failed YAML
write can follow a successful event commit. Replay does not resume model or Git work. See the
[discussion slice](../../openspec/changes/discussion-events/design.md) for process and limits.

## Review and run Desk itself

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
