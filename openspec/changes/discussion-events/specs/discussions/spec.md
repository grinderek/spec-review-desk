# Discussion history

#### Scenario: Resolve a discussion after the agent answers

Closing a discussion records its resolved status while retaining every message.

#### Scenario: Commit a proposed correction and require approval of its new meaning

The correction records patch metadata; changing meaning still requires fresh approval.

#### Scenario: Continue the same discussion with the owner's follow-up question

Owner and agent messages join the same ordered history.

#### Scenario: Open a discussion and retain the verified agent answer

The initial owner message and verified agent answer survive projection loss.

#### Scenario: Restore a closed discussion from its event history

A read rebuilds the closed conversation without invoking the model or external effects.
