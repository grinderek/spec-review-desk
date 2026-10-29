# Journal representation and historical context

Review YAML is a generated view. Supported event history is authoritative even if that YAML
is stale, missing or malformed. Without supported history, nonempty snapshot-only state and
invalid YAML fail explicitly; they are never an implicit source of owner approval.

Every review event is applied once in sequence to its preceding state. Projection handlers
receive the historical prefix, never final approvals computed from future events. Source
contracts and immutable blobs remain separate, versioned command inputs.

The writer prepares a complete target event representation using the existing business
schemas. Preparation may fill declared defaults, but unknown fields at any depth fail.
The decoder accepts only a representation that parsing leaves exactly unchanged. Reading
never inserts defaults, strips renamed fields or performs schema conversion. Envelope
versions remain review version 2 and initiative, verification and worktree version 1.
Unsupported versions, duplicate event UUIDs and stream/sequence conflicts fail explicitly.
A future incompatible field or meaning change requires a deliberate version decision;
there are no legacy imports, upcasters or compatibility adapters.

Recovery observes history only. It neither grants approval nor accepts a new execution or
Git receipt. Existing domain commands remain the only writers of business history.

A domain rename or reattachment is an explicit command against the state at that journal
position. Its removal/reattachment events precede any later approval and keep the facts
available at that point. Later approvals cannot be read backward to supply the moved entry,
and later decision anchors cannot change the scope of an earlier choice or patch binding.
Changing a JSON property is a representation change, not a domain rename: the old property
is refused explicitly instead of being stripped and replaced by a default.
