# The behavior-driven method: Gherkin + event sourcing + full-stack checks

This is how a behavior-driven change is written and verified. It starts from classic BDD — Gherkin
features run by Cucumber, one `Given … When … Then …` per behavior, a shared catalog of step phrases
(`features/STEPS.md`) — and adds two things:

1. **Event sourcing.** A scenario is an *event-sourcing specification*: `Given` lists the events
   already in the stream, `When` sends exactly one command or request, `Then` names the response
   (or the rendered page) and the events the command appended. The specification tests only the
   public contract — events in, request in, response and events out — never internal state, so the
   code behind it can be rewritten freely while the scenarios stay green.
2. **Full-stack checks through server-side rendering.** A `Then` step may read a page the server
   rendered and assert on what it shows. The whole stack runs in one process (routing, controllers,
   projections, views); no browser, no JavaScript, milliseconds per scenario. This is a matter of
   taste and speed — a `@javascript` scenario can still drive Playwright — but it is the default.
   It is our extension: Abdullin's use cases stop at the JSON response; a server-rendered page is
   the same public contract one step closer to the person reading it.

Rinat Abdullin's writing is the reference for the first part:

- the series — [Intro](https://abdullin.com/event-sourcing/intro/),
  [Why Event Sourcing](https://abdullin.com/post/event-sourcing-why/),
  [Aggregates](https://abdullin.com/post/event-sourcing-aggregates/),
  [Projections](https://abdullin.com/post/event-sourcing-projections/),
  [Specifications](https://abdullin.com/post/event-sourcing-specifications/),
  [Versioning](https://abdullin.com/post/event-sourcing-versioning/),
  [Migrating Legacy Systems](https://abdullin.com/post/migrating-legacy-systems-to-event-sourcing/);
- [Specification testing for event sourcing](https://abdullin.com/post/specification-testing-for-event-sourcing/)
  (Given events / When command / Expect events, printed as living documentation),
  [Scenario-based unit tests](https://abdullin.com/post/scenario-based-unit-tests-for-ddd-with-event-sourcing/)
  (specifications as text files; the outcome is 0..N events *or* a failure) and
  [a self-documenting example](https://abdullin.com/post/example-of-self-documenting-unit-test-with-event-sourcing/);
- [Event-driven specs](https://abdullin.com/btw/2015-01-26-event-driven-specs/) (Given events /
  When HTTP request / Then response + events, run against a module wired to a real HTTP server and
  an in-memory event bus; partial responses; a numbered list of issues to fix) and
  [Event-driven verification at SkuVault](https://abdullin.com/sku-vault/event-driven-verification/)
  (the same scenarios reused for idempotency, delta and random tests).

The Desk reads this shape back: it shows each scenario as `Given events → When command → Then
events`, marks a scenario that departs from the shape, and refuses an author's change that does
(§9).

## 1. The shape of a scenario

```gherkin
Feature: Threads are weighed for the inbox pillar

  # Events every scenario starts from — the world.
  Background:
    Given a founder in time zone "America/New_York"
    And it is "2026-09-22 14:00" in the founder's time zone

  Scenario: The founder's reply resolves a waiting thread
    Given the founder's mailbox holds these threads:
      | from           | arrived          | last from |
      | ceo@client.com | 2026-09-22 10:00 | founder   |
    When Gmail finished syncing at "2026-09-22 13:50"
    Then these events were recorded:
      | event          | thread         | reason   |
      | ThreadResolved | ceo@client.com | resolved |
    And the page "/inbox" shows:
      | Inbox score | 100 |
```

**Given — events, in the past tense.** Every `Given` phrase stands for one or more events appended
to the stream before the command runs; the catalog names the event (§2). A `Given` describes what
*happened*, never how the database looks: "the founder's mailbox holds these threads" appends
`MailboxSynced`, it does not insert rows. The steps append through the same path the application
uses (event store + projections), so a scenario proves the projections too. An empty `Given` is
legal: the command runs against a stream that does not exist yet (creating it, or being refused).

**The environment is `Given` too.** The clock, prices, a uniqueness index — anything the command
consults outside the stream — is configured by a `Given` phrase, the way Abdullin's specifications
configure test doubles with special events (`ClockWasSet(2011, 3, 2)`, `Price.SetPrice(…)`) or an
`Environment:` line. The printed specification then shows it (§5) instead of hiding it in a
`Before` hook. The catalog names such a phrase's event after what it pins (`ClockWasSet`), and the
phrase says so in its meaning.

**When — one command or request.** Exactly one `When` per scenario. It is a command
(`SyncGmail`), an HTTP request (`POST /api/gmail/sync`) or a page read (`GET /inbox`). A second
command belongs in its own scenario whose `Given` includes the events the first would have
produced — that is what makes each scenario independent and its failure readable.

**Then — the response or the page, and the events.** A `Then` asserts on these things and
nothing else:

- the *response* (status, fields — `the response includes:`) or the *rendered page* (`the page
  "/inbox" shows:`, §3). Only the paths the scenario is about are listed; the rest of the response
  belongs to other scenarios;
- the *events appended* by the command (`these events were recorded:`). The table is the whole
  outcome: the same events, in the same order, each matched by name and the fields listed. An
  event the command appended but the table does not list fails the scenario — as in Abdullin's
  verifier, which reports `Expected 'Events.length' to be '1' but got '0'`;
- `no events were recorded` when the command changes nothing: a query or page read (it never
  appends — command-query separation), or a rejected command.

A failure comes in two kinds, and the scenario says which:

- **A business outcome is an event.** When the domain decides "no" — the order cannot be shipped,
  the worker refuses the extra shift, the email is already taken — that decision is a fact worth
  keeping, and the command appends it: `OrderCantBeShipped`, `WorkerRefusedToExtendShift`,
  `RegistrationFailed`. The `Then` lists it like any other event.
- **A rejected command appends nothing.** Malformed input, a missing stream, a forbidden caller:
  the command is refused before any decision, with an error and no event — `Then the request was
  refused with "…"` and `no events were recorded`. (Abdullin's text scenarios expect an
  `InvalidOperation` in place of events.)

If the refusal is something a person will later ask about ("why was my registration refused?"),
it is the first kind.

**Values the server generates.** Ids, timestamps and tokens the command creates cannot be written
in advance. Name them in the table as placeholders — `<new thread id>`, `<now>` — and let the step
bind each placeholder to the first value it meets and compare every later use against it
(Abdullin's `Where: IgnoreEventId` and `ServerGenerated = {newId, newDate}`). A placeholder that is
only ignored is a field that should not be in the table.

`Then` never reads tables of the database or private state; if a fact matters, it is an event or
it is on a page.

**Order.** `Given*`, then one `When`, then `Then+`. `And`/`But` continue the previous keyword. No
`Given` after the `When`; no `When` after a `Then`.

**Tables.** Event fields and page rows go in data tables; a `Scenario Outline` varies one thing
per `Examples` row. Keep table columns to the fields the scenario is about — an event's other
fields are not compared.

## 2. The catalogs

`features/STEPS.md` holds every approved phrase; a change proposes new ones in
`features/NEW_STEPS.md`. Both keep the `## Given`, `## When`, `## Then` sections and add a third
column:

```markdown
## Given

| Phrase | Meaning | Event |
|---|---|---|
| `a founder in time zone {string}` | A founder account in that IANA zone. | `FounderRegistered` |
| `it is {string} in the founder's time zone` | Pins the clock at that local instant. | `ClockWasSet` |
| `the founder's mailbox holds these threads:` (table) | What Gmail holds for the founder. | `MailboxSynced` |

## When

| Phrase | Meaning | Command |
|---|---|---|
| `Gmail finished syncing at {string}` | Runs a Gmail sync to completion at that instant. | `SyncGmail` |
| `the founder opens {string}` | GET of that path as the founder. | `GET` |

## Then

| Phrase | Meaning | Event |
|---|---|---|
| `these events were recorded:` (table `event`, fields…) | The command appended exactly these events, in order, matched by name and the listed fields. | |
| `no events were recorded` | The command appended nothing (a query, a page read, a rejected command). | |
| `the request was refused with {string}` | The command was rejected before any decision, with that message. | |
| `the page {string} shows:` (table `label`, `value`) | The server-rendered page lists these labels with these values. | |
| `the thread {string} was resolved` | A `ThreadResolved` for that thread was appended. | `ThreadResolved` |
```

- **Event** (under Given and Then): the event the phrase appends or expects — `PascalCase`, past
  tense, named in the language of the domain (`MailboxSynced`, `ThreadResolved`). A name that
  opens with an imperative CRUD verb — `Create…`, `Insert…`, `Update…`, `Delete…`, `Set…`,
  `Change…`, `Add…` — is a command or a table write, not an event, and the Desk reports it
  (Abdullin: many events with these words in their names means the modeling went wrong).
  **Command** (under When): what the phrase sends, imperative (`SyncGmail`) or an HTTP verb.
  A generic phrase (`these events were recorded:`) leaves the cell empty; the events are in its
  table. A phrase that names one event (`the thread {string} was resolved`) asserts that this
  event is among those appended; only the `these events were recorded:` table says "and nothing
  else".
- A phrase sits in exactly one section. The Desk reports a `Then` phrase used as a `When` and the
  reverse.
- The column is optional: a catalog without it still works, and the Desk simply shows no
  `Given → When → Then` line. Add it phrase by phrase; every named event is one the code must
  actually emit, so the column doubles as the event catalog.

## 3. Full-stack checks through server-side rendering

A page assertion runs the real request through the real stack and reads the HTML the server
returned — Capybara's `rack_test` driver in a Rails corpus, or a plain `get` and `response.body`.
There is no browser and no JavaScript, so a scenario runs in milliseconds and cannot flake on
timing. Assert on what a person would read (labels, values, row counts), not on DOM structure:

```gherkin
    And the page "/inbox" shows:
      | Inbox score | 100 |
    And the page "/inbox" lists 2 threads
```

When a behavior only exists in the browser (a live update, a drag), tag the scenario
`@javascript` and let Cucumber switch to a Playwright or Selenium driver for it — the exception,
kept rare, never the default. The events the page derives from are still `Given`; the page is
still read after the one `When`.

## 4. Implementing the steps

The step definitions live in the corpus repository (`features/step_definitions/`, `features/support/`).
The sketch below is Ruby/Cucumber on Rails; the shape is language-independent.

```ruby
# features/support/spec_world.rb — the scenario as an event-sourcing spec.
module SpecWorld
  def given(event)                 # Given: append through the real path, projections included
    EventStore.append(event)
    Projections.apply(event)
    (@given ||= []) << event
  end

  def when!(&block)                # When: remember where the stream was, run the one command
    @mark = EventStore.position
    @response = block.call
  rescue CommandRejected => e      # a rejected command: no decision, no event (§1)
    @refusal = e
  end

  def recorded = EventStore.since(@mark)   # Then: the events the command appended
  attr_reader :response

  # Placeholders (`<new thread id>`) bind to the first value they meet; later uses must match it.
  def same?(expected, actual)
    return expected == actual.to_s unless expected.match?(/\A<.+>\z/)
    (@bound ||= {}).key?(expected) ? @bound[expected] == actual.to_s : (@bound[expected] = actual.to_s; true)
  end
end
World(SpecWorld)
```

```ruby
# features/step_definitions/inbox_steps.rb
Given('the founder\'s mailbox holds these threads:') do |table|
  given MailboxSynced.new(founder_id: founder.id, threads: table.hashes)
end

When('Gmail finished syncing at {string}') do |at|
  when! { travel_to(founder.local(at)) { post '/api/gmail/sync' } }   # or Commands.dispatch(SyncGmail.new(at:))
end

Then('these events were recorded:') do |table|
  actual = recorded.map { |e| { 'event' => e.class.name }.merge(e.to_h.transform_keys(&:to_s)) }
  issues = []
  issues << "Expected 'Events.length' to be '#{table.hashes.size}' but got '#{actual.size}'" if actual.size != table.hashes.size
  table.hashes.each_with_index do |expected, i|
    expected.reject { |_, v| v.to_s.empty? }.each do |field, value|
      got = actual.dig(i, field)
      issues << "Expected 'Events[#{i}].#{field}' to be '#{value}' but got '#{got || 'nothing'}'" unless got && same?(value, got)
    end
  end
  raise SpecFailure.new(self, issues) if issues.any?   # prints the specification, then the issues (§5)
end

Then('no events were recorded') do
  expect(recorded).to be_empty
end

Then('the request was refused with {string}') do |message|
  expect(@refusal&.message).to eq(message)
end

Then('the page {string} shows:') do |path, table|
  visit path                                   # Capybara rack_test: server-rendered HTML only
  table.raw.each { |label, value| expect(page).to have_css('[data-row]', text: /#{label}.*#{value}/) }
end
```

Rules the implementation keeps:

- `Given` steps never write projections or tables directly; they append events and let the
  projections apply them, exactly as production does.
- `When` runs the command once, through the public entry point (HTTP or the command dispatcher),
  and records the response — status, body, or the raised refusal.
- `Then` compares the events *since the `When`* with the expected ones: the same count, in order,
  by name and the listed fields; unlisted fields are ignored, an unlisted event fails.
- Integrations are events: Gmail is `MailboxSynced`, a clock is `it is …`. The real adapter is
  tested by a contract test outside the corpus.
- The database is a transaction per scenario (DatabaseCleaner or an in-memory store); the corpus
  runs in the warm `nucleus-bdd` container on every file change and finishes in seconds.
- Every event and command class has a readable `to_s` in the domain's language — it is what the
  printed specification and the failure report show (§5).
- On a failure, print the specification, not the stack (§5).

## 5. Printing specifications and comparing events

A specification is data, so it prints. Abdullin's runners print every specification — passed or
not — as a short story, and the whole suite doubles as living documentation a business person can
read, correct and sign off:

```text
Threads are weighed for the inbox pillar: the founder's reply resolves a waiting thread — Failed

GIVEN:
  1. Founder registered in America/New_York
  2. Clock was set to 2026-09-22 14:00 America/New_York
  3. Mailbox synced: ceo@client.com (arrived 2026-09-22 10:00, last from founder)

WHEN:
  Sync Gmail at 2026-09-22 13:50

THEN:
  1. Thread ceo@client.com resolved: resolved
  Page /inbox shows: Inbox score 100

Issues to fix:
  1. Expected 'Events.length' to be '1' but got '0'
  2. Expected 'Events[0].event' to be 'ThreadResolved' but got 'nothing'
  3. Expected page '/inbox' to show 'Inbox score' = '100' but got '72'
```

- **The lines come from `to_s`.** Each event and command renders itself in the domain's words (the
  trick is only an override of `to_s` / `ToString()` on the contract classes). The Gherkin text
  is what the owner approved; the printed events are what the code actually did with it, so a
  step that appends the wrong event shows up in the printout even when it passes.
- **Issues, not a dump.** A failure ends with a numbered list of differences, one per field, so the
  developer fixes them one at a time and re-runs; a raw object diff or a stack trace is shown only
  on request.
- **Readable first, structural second.** Compare events field by field; report a difference with
  both events' `to_s` side by side. If the two strings are equal (the differing field is not in
  `to_s`), fall back to the member-by-member diff. Many member-by-member diffs mean the `to_s` does
  not say what the event is about — fix the `to_s`.
- **Progress is a number.** Scenarios written from the owner's text before the code exists are the
  to-do list: passing / total is how far the implementation has got.

## 6. Projections in the scenarios

A page is a projection: a read model derived from the events, rebuilt at will by replaying them.
The scenarios lean on that:

- **Projections run in every scenario.** `Given` events go through the real projections, so a page
  assertion after the `When` checks both the command's events and the read model built from them.
  A scenario about a projection alone has `Given` events and a page read as its `When`, and
  `no events were recorded`.
- **Never assert on the read model's storage.** The page (or the response built from the read
  model) is the contract; its table layout may change and be rebuilt from the events.
- **A new or changed projection is proven by replay.** Since the read model is only a function of
  the events, the scenarios that already exist exercise it; a new page gets its own scenarios with
  the events it reads in `Given`.
- **The same scenarios run in other modes** (SkuVault): *idempotency* — every `Given` event is
  delivered twice and the outcome must not change, which proves projections and handlers tolerate
  a duplicate delivery; *delta* — the same scenarios run against two implementations (an
  in-memory one and the production store) and every output, even unlisted fields, must be equal.
  The corpus may add these modes without touching a single scenario.

## 7. Versioning the events

Events are the contract the scenarios are written in, so they change more slowly than code — but
they change (Abdullin, [Versioning](https://abdullin.com/post/event-sourcing-versioning/)):

- **Renaming a field** is free with an evolution-friendly serializer; otherwise it is an upgrade.
- **Enriching** an event (adding the field a new page needs, e.g. the user's name on
  `UserDisabled`) beats a projection that stitches the field together from other events. Old events
  in the store lack the field: an *upgrader* fills it in while the stream is read.
- **Splitting or merging** (`AccountRegistered` → `AccountCreated`, `UserAdded`, `UserActivated`) is
  an upgrader that returns several events for one. Upgraders live with the contracts, are ordered
  by the date they were written, and are a shortcut: the stream can later be rewritten through
  them and they can go.
- **The scenarios follow the current contract.** Renaming an event in the catalog's Event column
  is a versioning change, not a rename: the `Given` phrases switch to the new event, an upgrader
  handles the stored history, and one scenario whose `Given` holds the old event shape proves the
  upgrader.
- **The scenarios are also the serializer's test data.** Collect every event and command that
  appears in any `Given`, `When` or `Then`, round-trip each through the serializer and compare —
  every contract is covered with realistic values without writing a single extra fixture.

## 8. Writing a change

The author writes `features/*.feature`, `features/NEW_STEPS.md` and `specs/**/spec.md`; the
`#### Scenario:` titles in the spec are identical to the scenario titles (the join key).

1. Name the command the change introduces or alters; one scenario per outcome of that command
   (happy path, each refusal — recorded as an event or rejected with none (§1) — each branch of
   the projection).
2. Write the `Given` as the events the outcome depends on — reuse `STEPS.md` phrases, add the
   missing ones to `NEW_STEPS.md` with their event.
3. Write the one `When`.
4. Write the `Then` as the events appended and the response or page a person sees. If the scenario
   needs something a page does not show and no event carries, that is a missing event — add it.
5. Read the scenario back as a sentence: "Given these things happened, when this was asked, then
   these things happened and this is what the page shows." If it does not read, split it.

An initiative is sliced by command, not by layer: each slice pins the commands it introduces and
the events they produce, and a later slice's `Given` may use the events an earlier slice added.

## 9. What the Desk checks

- **Shape.** For every scenario (Background included): exactly one `When`, at least one `Then`, no
  `Given` after the `When`, no `When` after a `Then`, a first step that is a primary keyword,
  every catalogued phrase used under the section it sits in, and no `Given`/`Then` event named like
  a CRUD command (`UpdateThread`, `SetPrice`). A departure shows as an *off shape*
  pill with the reasons on the scenario card. A change the sandboxed **author** proposes is refused
  with the same messages before anything is moved into the worktree; a hand-written change is only
  marked, the owner decides.
- **Specification line.** Each scenario card shows `Given events → When command → Then events`
  from the catalogs' Event / Command column; the Phrases tab shows the column.
- **Catalog.** As before: every step is underlined by catalog status, a new phrase is approved by
  the owner, an extended meaning is flagged.

## 10. Moving an existing corpus

Nothing has to change at once. Add the Event / Command column to `STEPS.md` a phrase at a time;
scenarios with two `When`s split into two; `Given` steps that seed tables become the events those
rows came from (usually one phrase per integration). A scenario that cannot be phrased as events
plus one command is describing two behaviors — or a behavior nobody asked for.

The application's data moves the same way (Abdullin,
[Migrating Legacy Systems](https://abdullin.com/post/migrating-legacy-systems-to-event-sourcing/)):
a throw-away tool reads the old tables and emits the events that would have produced each row.
They are an estimate, not history — what the tables forgot (when a customer was deleted) is
improvised, with a fixed, documented value such as the migration date. Replay them through the
projections and compare the pages with what the old system shows; inconsistent or corrupt rows
surface there and are fixed by hand. Old rows seeded in a `Given` become exactly these events.
