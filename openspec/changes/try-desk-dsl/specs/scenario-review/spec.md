## ADDED Requirements

### Requirement: Executable review contracts

Desk SHALL execute and review the following event/command contracts.

#### Scenario: Resolve a discussion after the agent answers
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Commit a proposed correction and require approval of its new meaning
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Continue the same discussion with the owner's follow-up question
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require recorded owner approval before implementation starts
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Recognize a slice as applied only when its implementation matches
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Resume implementation after recording the requested owner choice
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Show the actual verification result for a reviewed contract
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require renewed approval when a contract changes before implementation
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reapply approved contracts when their implemented corpus drifts
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Create an initiative with the owner's brief
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Save the revised brief for future agent runs
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep an agent's slice plan as a draft until owner approval
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Approve the slice plan before proposing changes
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Resolve blocking owner questions before approving the plan
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Propose a ready slice as a change that still needs owner review
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Refuse a dependent slice while its prerequisite is unfinished
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Accept a research draft before agents can use it as an input
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Propose a dependent slice once its prerequisite is owner approved
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Resume research with the reading permission chosen by the owner
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Record a whole-change choice in the owner decision log
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Send a scenario choice to the agent for a resolving patch
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Complete a scenario choice only after committing its resolving patch
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Dismiss an owner question with an explicit reason
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Request changes and open an owner discussion
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Approve a phrase by its current meaning
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Revoke approval of a proposed phrase
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Commit owner approval and its event history
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Refuse to record a change with an unapproved scenario
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Drop an orphaned review entry
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reattach a review entry without approving different content
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Block only unresolved decisions marked as blocking
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require review discussions to be resolved while ignoring Apply discussions
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require every proposed phrase to be approved
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Approve the current scenario contract
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Revoke a scenario approval
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require approval after the contract changes
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve approval after YAML formatting changes
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Open a discussion and retain the verified agent answer

Discussion messages and status are projected from the review journal.

#### Scenario: Restore a closed discussion from its event history

Losing the derived review view preserves the closed conversation without repeating the agent call.

#### Scenario: Keep a patch unconfirmed when its Git commit fails

A materialized correction is not applied until a verified Git commit exists. Pending application blocks readiness.

#### Scenario: Keep the owner choice blocking when its decision commit fails

The executable contract records the command, journal events and public observations.

#### Scenario: Retry the pending decision commit without choosing again

The executable contract records the command, journal events and public observations.

#### Scenario: Recover the recorded choice and its readable log from event history

The executable contract records the command, journal events and public observations.

#### Scenario: Restore the approved plan and research material from initiative history

The executable contract records the command, journal events and public observations.

#### Scenario: Discard research without accepting it as agent input

The executable contract records the command, journal events and public observations.

#### Scenario: Record the owner's allowed research domains

The executable contract records the command, journal events and public observations.

#### Scenario: Refuse an old correction after its owner choice moves to another scenario

A correction remains bound to the exact scenario and choice shown to its agent. Reattaching the decision requires a fresh resolving correction.
