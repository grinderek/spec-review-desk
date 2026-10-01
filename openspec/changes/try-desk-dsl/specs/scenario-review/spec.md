## ADDED Requirements

### Requirement: Executable review contracts

Desk SHALL execute and review the following event/command contracts.

#### Scenario: Reject a contract containing two commands
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reject an unknown contract field
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reject duplicate YAML keys
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

#### Scenario: Reject invalid review input without changing history
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

#### Scenario: Reject orphan reassignment to a missing entry or target
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Recover scenario, phrase and change approvals from history
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve review keys containing punctuation and Unicode
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Render an invalid review projection as a blocking error
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve external metadata when recording a phrase approval
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve both approvals when prior events arrive concurrently
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep journalled approval despite a manual projection edit
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve discussion and decision contracts across a review update
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep existing approvals when extending a legacy review history
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Mark a change ready when all reviews and discussions are complete
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

#### Scenario: Refuse readiness without any scenario
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require matching unique scenario titles in contracts and specs
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep valid scenarios visible while reporting a malformed feature
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require legacy Gherkin phrases to be catalogued
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Display legacy scenarios, phrase usage and owner decision provenance
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: List owner obligations and identify a decision whose scenario disappeared
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Approve the current scenario contract
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Revoke a scenario approval
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep approval while the contract is unchanged
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Require approval after the contract changes
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Recover scenario approval from events after projection loss
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reject approval of an unknown scenario
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Reject writes to an archived change
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Leave an unreviewed scenario pending
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Keep requested changes while the contract is unchanged
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match

#### Scenario: Preserve approval after YAML formatting changes
- **WHEN** the declared command executes with its given history and environment
- **THEN** the declared events, response and observations match
