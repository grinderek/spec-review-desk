# Initiative business events

The initiative scope owns `initiative.events.jsonl`. Its version 1 envelope contains stream,
event and command UUIDs, contiguous sequence numbers, time and origin. Each command reads replayed
business state plus current run and dependency facts, decides named events, then writes one batch
with byte-version CAS and atomic rename. The scope uses the same canonical queue and Linux flock
protocol as review. Readers rebuilding files also take that lock.

Events are InitiativeCreated, InitiativeBriefSaved, InitiativeInputAdded, ResearchInputAccepted,
ResearchInputDiscarded, ResearchDomainsSet, ResearchDomainsGranted, SlicePlanDrafted,
SlicePlanEdited, SlicePlanApproved and SliceChangeAssociated. There is no generic snapshot-diff
event. Generic initiative updates may only change the remaining run snapshot; changing migrated
business fields through that path fails.

Brief and input content live in immutable SHA-256 `blobs/<hash>` files. Events reference hashes,
and input events retain names, size, source provenance, time and draft status. Reads restore
`brief.md` and listed `inputs/*` from checked blobs. Discard removes a draft from the current view
without deleting its historical blob. Missing or corrupt immutable source material fails clearly;
it is not reconstructed from a possibly edited view. Symlink escapes are rejected.

Plan edit/approval and planner/author result registration share the initiative scope lock. Plan
approval checks blocking decisions and in-flight planners under it. Proposal dependencies remain
derived from reviewed changes. Slice association is explicit, including removal after a failed
author commit. The lock does not block an external editor or Git process.

Research reading grants correlate to a confirmed owner decision commit. A grant uses the decision
ID for idempotency. Review and initiative journals and Git are separate resources; there is no
cross-resource atomicity promise. S4 adds durable execution/effect recovery. This slice preserves
the existing Git failure response semantics; recorded business facts survive a failed commit.

`initiative.yaml` is a generated business view plus the still-authoritative run snapshot. Loss of
that file restores business state, but run recovery remains S4 work. Replay only projects data and
files; it never runs Codex, grants a new permission or creates a Git commit. Initiative discovery
uses the journal, so deleting the YAML view does not hide the initiative.

Executable contracts select `then.stream: initiative` for business operations. The runner compares
the complete delta in that stream and does not invent ordering between review and initiative
streams. Existing owner decision contracts observe review history and assert grant effects using
public GETs. New contracts cover restoration, draft discard and research domain permission.
