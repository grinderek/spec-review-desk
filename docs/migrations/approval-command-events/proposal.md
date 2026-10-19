# Explicit commands for all approval operations

Complete S1 of the Event Sourcing migration. Scenario approve/revoke, request-changes, phrase
approve/revoke, whole-change approval and orphan drop/reattach now decide explicit events from
replayed approval state and current source facts. The shared writer records events and projects
approval fields; unrelated review fields retain YAML persistence.

The owner's later instruction removes internal backward compatibility. Only version 2 journals
are accepted. Version 1, import checkpoints and snapshot diffs are removed; unsupported history
fails explicitly and is never rewritten or imported automatically.

Existing product rules remain covered by `features/scenario-approval.desk.yaml`,
`features/review-actions.desk.yaml` and readiness contracts. No new product rule or duplicate
contract/spec is introduced. Existing Given adapters now provide prior events through the
production writer in disposable repositories. No owner history is changed by the agent.

See [design.md](design.md) for the process, effects and limits, and [tasks.md](tasks.md) for validation.
