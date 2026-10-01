## Scope

This first slice migrates scenario review state to events. Threads, decisions, phrases and agent runs retain their current persistence. YAML DSL coexists with Gherkin. Existing tests are removed only where the executable corpus replaces them.

## Persistence

Scenario review history commits before review.yaml projection writing. Reading replays history even if the projection is missing. Existing YAML approvals are imported on the first scenario-changing write. Only scenario review state is recovered from this journal.
