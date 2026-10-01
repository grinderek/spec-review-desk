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

Each `then.reads` entry issues a GET, can bind generated fields and compares its response. Observing
state must not emit events. Optional `then.git` checks head, parent, message and changed files of the
resulting commit. Responses and event payloads match listed object fields recursively; arrays match
length and order exactly. Events match exact count, order and type. Status can be an HTTP number or
a case variable. Failures identify the contract, case and field; empty or malformed corpora fail.

## The review adapter

`scripts/desk-specs/review-world.mts` creates a clean Git repository, real Hono app, security
middleware, discovery, disk-backed review store and review routes for every execution. Commands
cover scenario/phrase approvals and revocations, requests for changes, change approval and orphan
operations. Reads expose change and summary views. A domain adapter is defined once per operation.

Given facts prepare source contracts, phrases, prior approvals, discussions, decisions, legacy
reviews, malformed files and archival conditions. Approvals use the same serialized writer as
production. Concurrent prior approvals test this writer, followed by a public HTTP read. Fixture
bindings include `$key`, `$hash`, `$head`, `$at`, `$change`, `$phrase` and `$phraseHash`. Production
commands generate their own ids and times. The question service uses a deterministic model transport
while running real reply validation and persistence. No LLM or Docker is required for this corpus.

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
same hash. See [the review migration map](review-migration.md) for removed legacy checks. Other
legacy domains and browser checks remain. Live authoring through a Codex account is outside these
offline contracts.
