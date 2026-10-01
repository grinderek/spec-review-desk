# Desk DSL v1: experimental executable contracts

This first slice replaces free-form step phrases with named events and commands in YAML.
It coexists with Gherkin. The executable corpus is `features/*.desk.yaml`; the proposed change
under `openspec/changes/try-desk-dsl` contains the same contracts for owner review.

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

A scenario has a stable lowercase id, a readable title, prior event/environment facts, one named
command and an explicit expected event list and response. Each event/command is a single-key
mapping with a mapping payload. `events: []` expects no appended events. Unknown structural fields,
duplicate YAML keys, aliases, duplicate ids and multiple commands are rejected. Version 1 does not
support page assertions, outlines, arbitrary expressions or automatic binding of generated values.
Those require concrete examples before extending the language.

Response objects match only the listed fields, recursively. Arrays match length and order exactly.
Events match exact count, order and type, then the listed payload fields. The runner reports the
scenario and failing field and returns nonzero on any failed scenario. YAML/source errors also fail
the command; there is no success when the corpus is empty. No LLM or Docker is used to run specs.

## The first application adapter

`run-desk-specs.mts` creates a clean git repository per scenario, the real Hono app, security
middleware, discovery and review routes, and the real disk-backed review journal. It dispatches
ApproveScenario, RevokeScenarioApproval and ReadChange through authenticated HTTP requests.
A domain adapter is written once for a command/event, not once per wording of a scenario.

ScenarioDiscovered and ScenarioRevised describe the external repository contract: they create or
change its source before the command. ScenarioReformatted changes presentation alone.
ContractSourceWritten provides deliberately malformed source. ChangeArchived and ReviewProjectionLost
pin external conditions. ScenarioApproved and ScenarioChangesRequested enter history through the
same serialized writer used by production; reading projects through the real application.
Fixture bindings are $key, $hash, $head, $at and $change. $hash follows the current source contract.
The production command generates its own approval time; tests do not substitute the clock.

ScenarioApproved, ScenarioChangesRequested and ScenarioReviewRemoved are versioned journal events.
Their concrete stored payloads are validated in review-store.ts. The first two contain the scenario
key and review entry; the DSL adapter exposes key/hash/commit/at as a flat contract for comparison.

## Persistence and migration boundary

Scenario review events live in `review.events.jsonl` beside `review.yaml`. Writers atomically replace
the journal with its existing history plus new events before updating the YAML projection. Reading
replays scenario history, including after projection loss. Existing YAML scenario reviews are
imported when the first scenario-changing update occurs. Once journaled, manual edits to the YAML
scenario section are not authoritative. Other YAML fields retain their current behavior. Missing
projection recovery covers scenario reviews, not threads, decisions, phrases or agent runs.

Commands and updates are serialized by the existing per-change, per-process lock. Running multiple
Desk server processes against the same change is not supported. Journal rewrite cost grows with
history; an append store with process-safe locking is a later storage change. A projection-write
failure may leave a successful journal write; reads recover the scenario state from that history.
Git commits and unstaging of review.yaml include its journal. Reviewer patches and author output
cannot supply review history.

## Review and run the Desk itself

```sh
npm run test:spec
npm run desk
```

`config.desk.yaml` discovers this repository and configures an explicit local runner invoking
`npm run test:spec`. Run now on the change screen executes it and reads its scenario results.
Local runners execute the configured argv on the host; configuration is trusted. Existing compose
runners remain supported. Results are written under gitignored `.spec-review/` and include native
Desk envelopes in last-run.ndjson alongside support for older Cucumber envelopes.

The UI displays the YAML contract, its event/command summary, approvals and contract diffs. Scenario
keys use file::id. Hashes use canonical structured content: comments, indentation and mapping-key
order do not invalidate approval; changed expectations do. Corpus comparison uses the same hash.

Only the covered legacy checks have been removed. Other legacy tests and the browser suite remain
until corresponding executable contracts replace them. Author/reviewer/Apply instructions know
both formats; end-to-end authoring through a live Codex account is not part of this offline prototype.
