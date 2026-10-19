# Native change packages and stable contract identity

This is the implementation decision for S6-S7. It follows the owner's instruction to remove
internal compatibility support. It does not change owner approval history.

## Package layout

```text
desk/
  changes/<name>/
    change.yaml
    features/**/*.desk.yaml
    features/**/*.feature       # optional native Gherkin contracts with explicit scenario IDs
    proposal.md                 # optional explanatory prose
    design.md                   # optional explanatory prose
    tasks.md                    # optional work notes
    review.events.jsonl         # owned by Desk
    review.yaml                 # generated view after run migration
    decisions.md                # generated readable decision view
  initiatives/<name>/
    initiative.events.jsonl
    blobs/<sha256>
    initiative.yaml
    brief.md
    inputs/*
features/                       # implemented executable corpus
.spec-review/                   # ignored operational logs, receipts and generated caches
```

`change.yaml` declares `version: 1` and `kind: behavior-driven`. The directory identifies the
change; metadata does not repeat the directory name. Optional title and created date are readable
metadata, not approval identity. At least one executable contract is required. Native discovery
does not read .openspec.yaml or search a legacy path. Archived native changes live in
desk/changes/archive/<name>/ and remain read-only in the existing public workflow.

Plain prose is optional. Specs copied by hand into specs/**/spec.md are removed from validation
and readiness. Human-readable contract documentation is generated from the executable contracts,
including Given/When/Then, cases and public observations. A prose edit cannot supply a missing
executable rule or pass readiness by matching its heading.

## Identity

The canonical contract key is `relative-feature-path::scenario-id`. Relative paths retain nested
directories. The one common identity function removes only the leading features/ namespace when
appropriate; it never reduces paths to their basename. For example,
features/billing/approve.desk.yaml and features/shipping/approve.desk.yaml stay distinct.

Desk YAML already requires stable IDs. Native Gherkin requires one explicit @id:<stable-id> tag
per scenario, unique within its file. Existing Gherkin support is a product capability, not an
OpenSpec adapter. Untagged scenarios fail native validation instead of receiving a title-derived
fallback. Cucumber result decoding reads that ID from the Gherkin document. Display titles remain
labels and can never join approvals, corpus comparison or execution results.

One identity representation must be used by the YAML parser, Gherkin parser, corpus comparison,
verification producer/consumer, API and UI. It is accompanied by the exact contract/source hash
for the verified execution. Stable identity does not make an older passing result evidence for
new source content. Duplicate IDs and ambiguous paths fail explicitly. No legacy title mapping
is added.

## Replacement surface confirmed in the current code

| Surface | Current dependency to replace |
| --- | --- |
| discovery.ts and watch.ts | openspec/changes and .openspec.yaml |
| vet-output.ts | output layout, schema marker, spec-title join and external openspec validate |
| change-view.ts and readiness.ts | duplicated Markdown title join as a business gate |
| room.ts | copied OpenSpec specs/schema instead of native contracts and generated context |
| author-run.ts, initiative-prompt.ts and author prompt | OpenSpec author output and installation paths |
| apply.ts and Apply/reviewer prompts | mandatory OpenSpec workflow instructions and paths |
| initiative stores, creation, UI command preview | openspec/initiatives paths and commit wording |
| corpus.ts and run-messages.ts | basename/title result and corpus keys |
| UI keys and ScenariosTab | duplicated basename/title result lookup |
| config.ts, testing helpers and browser fixtures | openspecBin and fake OpenSpec validation |
| scripts/verify-desk-self.mts | OpenSpec self-development change and title-derived result keys |

The package module owns layout, metadata parsing, contract discovery and native structural
validation. It does not run an external CLI. Author vetting keeps path, type, size, catalog,
shape and secret checks, then uses that same native validator. It continues to refuse
Desk-owned state/history files in agent output. Room assembly uses immutable input refs captured
by execution and includes executable contracts and generated documentation.

## Cutover and verification

Repository-owned proposed changes and initiatives move to the native layout. This operation must
not invent approvals or transform an unknown external review history. Runtime supports only the
new internal format. Research about OpenSpec may remain as historical prose; executable code,
configuration, prompts and fixtures must not require it.

The completion check must cover create initiative -> draft/approve plan -> author native change
-> review contracts -> approve -> Apply -> verify matching implementation, plus self-development
through Desk. Run it with no OpenSpec executable and no fake replacement. Verify both YAML and
explicit-ID Gherkin, a title rename with unchanged identity, nested same-basename contracts, and
results bound to their original execution/source version. Observe actual public operations and
their journals; string search alone does not prove the cutover.
