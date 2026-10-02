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
Do not write standalone unit or technical integration tests in this repository. Do not extend
the language or add cases to reproduce removed implementation checks.
The review corpus retains its 14 rules. Discussions, owner decisions, initiatives, research,
implementation and verification add 23 core rules: 37 contracts / 50 executions across the app.
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
exactly. Approval-journal events match exact count, order and type. Response status is an HTTP number. Failures
identify the contract, case and field; empty or malformed corpora fail.

## The review adapter

`server/testing/desk-world.ts` composes the domain adapters around
`server/testing/review-world.ts`, which creates a clean Git repository, real Hono app, security
middleware, discovery, disk-backed review store and review routes for every execution. Commands
cover review, discussions and patches, owner decisions, planning, research, authored changes, Apply
and verification. Reads observe actual change, initiative, corpus and runner views. A domain adapter
is defined once per operation; expectations stay in the contracts.

Given facts prepare source contracts, phrases, prior approvals, discussions and decisions.
Approvals use the same serialized writer as production. Technical details are verified with compiler checks and targeted manual inspection, without a
separate test suite or additional technical contracts. Fixture
bindings include `$key`, `$hash`, `$head`, `$at`, `$change`, `$phrase` and `$phraseHash`. Production
commands generate their own ids and times. The question service uses a deterministic model transport
while running real reply validation and persistence. Initiative and Apply workflows use the existing
fake Codex CLI and sandbox transport, with real protocol parsing, services, finishers, vetting and
Git writes. Local verification executes a real subprocess with a controlled workload. No live LLM
or Docker is required for this corpus.

Other domains retain their existing storage: `then.events` checks the approval journal, not every
notification on the event bus. Their product contracts observe persisted state through public
views; `events: []` ensures they do not accidentally write approvals. No domain events are invented
from expected states, and this migration does not claim event sourcing for the entire application.

## Persistence and compatibility

`review.events.jsonl` stores versioned ScenarioApproved, ScenarioChangesRequested,
ScenarioReviewRemoved, PhraseApproved, PhraseChangesRequested, PhraseReviewRemoved,
ChangeApprovalRecorded and ChangeApprovalRemoved events. Entry payloads are stored under `entry`;
the adapter exposes key/hash/commit/at for assertions. ScenarioChangesRequested can include the
initial owner thread. Subsequent conversation, decisions and agent runs remain in `review.yaml`.

Writers atomically replace the journal with existing history plus new events before updating the
YAML projection. Reads replay all approval state after projection loss. Original YAML reviews and
older scenario-only journals import their prior approval state once through a versioned
ReviewApprovalHistoryExtended checkpoint. Import checkpoints are excluded from new domain event
assertions. Journaled approvals override manual YAML approval edits; other fields retain YAML
behavior. Invalid YAML or history is rejected rather than silently repaired.

The existing per-change, per-process lock serializes updates. Multiple server processes writing
one change remain unsupported; journal rewrite cost grows with history. A failed projection write
can leave a successful journal write, from which approval state is recovered. Git commits and
unstaging of review.yaml include its journal. Agents cannot supply or edit approval history.

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
