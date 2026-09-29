// A small behavior-driven change modelled on add-health-score-email-inputs.
export const FEATURE = `@thread-state
Feature: Threads are weighed for the inbox pillar
  Threads that wait on the founder count against the inbox.

  # The world: Tuesday 2026-09-22 14:00 in New York.
  Background:
    Given a founder in time zone "America/New_York"
    And it is "2026-09-22 14:00" in the founder's time zone

  # The replied thread is not a candidate, so no verdict is asked for.
  # Owner decision 2026-09-23: ONE reason, \`resolved\`, for "the ball is not in the
  # founder's court"; outbound_latest is retired.
  Scenario: The founder's reply resolves a waiting thread
    Given the founder's mailbox holds these threads:
      | from           | arrived          |
      | ceo@client.com | 2026-09-22 10:00 |
    When Gmail finished syncing at "2026-09-22 13:50"
    Then the response includes:
      | components.inbox.display_score | 100 |

  Scenario Outline: A waiting thread is weighted by its age
    Given the founder's mailbox holds these threads:
      | from           | arrived   |
      | ceo@client.com | <arrived> |
    When Gmail finished syncing at "2026-09-22 13:50"
    Then the founder's inbox read lists <count> messages

    Examples:
      | arrived          | count |
      | 2026-09-22 13:00 | 1     |
      | 2026-09-18 16:00 | 2     |
`

export const STEPS_MD = `# Step catalog — the living corpus under \`features/\`

Every phrase a \`.feature\` may use.

- **Response field tables** (\`| field | value |\`): \`field\` is a dotted path.
- **Event** names the event a Given phrase appends to the stream or a Then phrase expects there;
  **Command** names what a When phrase sends.

## Given

| Phrase | Meaning | Event |
|---|---|---|
| \`a founder in time zone {string}\` | A founder account in that IANA zone. | \`FounderRegistered\` |
| \`it is {string} in the founder's time zone\` | Freezes the clock at that local instant. | |

## When

| Phrase | Meaning | Command |
|---|---|---|
| \`Gmail finished syncing at {string}\` | Runs a Gmail sync to completion at that instant. | \`SyncGmail\` |

## Then

| Phrase | Meaning | Event |
|---|---|---|
| \`the response includes:\` (table) | Compares the listed fields; a table row \`| field | value |\` per field. | |
`

export const NEW_STEPS_MD = `# New step phrases — add-thread-state

Two new phrases.

## Existing phrase whose meaning this change extends (no new text)

| Phrase | Extended meaning |
|---|---|
| \`Gmail finished syncing at {string}\` | Also triages the new candidates before counting them. |

## Given

| Phrase | Meaning | Event |
|---|---|---|
| \`the/another founder's mailbox holds these threads:\` (table \`from\`, \`arrived\`) | What Gmail holds for the founder. | \`MailboxSynced\` |

## Then

| Phrase | Meaning | Event |
|---|---|---|
| \`the founder's inbox read lists {int} message(s)\` | GET /api/gmail/messages returns exactly that many items. | \`InboxRead\` |
`

export const SPEC_MD = `## ADDED Requirements

### Requirement: Replies resolve threads
The system SHALL treat a thread whose latest message is the founder's as resolved.

#### Scenario: The founder's reply resolves a waiting thread
- **WHEN** the founder's reply is the latest message
- **THEN** the thread is excluded as resolved

#### Scenario: A waiting thread is weighted by its age
- **WHEN** a thread waits
- **THEN** its weight follows its business-hour age
`
