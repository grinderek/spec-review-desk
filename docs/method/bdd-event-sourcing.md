# The behavior-driven method: Gherkin + event sourcing + full-stack checks

This is how a behavior-driven change is written and verified. It starts from classic BDD — Gherkin
features run by Cucumber, one `Given … When … Then …` per behavior, a shared catalog of step phrases
(`features/STEPS.md`) — and adds two things:

1. **Event sourcing.** A scenario is an *event-sourcing specification*: `Given` lists the events
   already in the stream, `When` sends exactly one command or request, `Then` names the response
   (or the rendered page) and the events the command appended. Rinat Abdullin's series is the
   reference: [Event Sourcing](https://abdullin.com/event-sourcing/intro/),
   [Specifications](https://abdullin.com/post/event-sourcing-specifications/),
   [Event-driven specs](https://abdullin.com/btw/2015-01-26-event-driven-specs/) (the same
   Given events / When request / Then response + events, run against a module wired to a real HTTP
   server and an in-memory event bus), [Projections](https://abdullin.com/post/event-sourcing-projections/).
2. **Full-stack checks through server-side rendering.** A `Then` step may read a page the server
   rendered and assert on what it shows. The whole stack runs in one process (routing, controllers,
   projections, views); no browser, no JavaScript, milliseconds per scenario. This is a matter of
   taste and speed — a `@javascript` scenario can still drive Playwright — but it is the default.

The Desk reads this shape back: it shows each scenario as `Given events → When command → Then
events`, marks a scenario that departs from the shape, and refuses an author's change that does
(§6).

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
uses (event store + projections), so a scenario proves the projections too. The clock is part of
the world: freeze it in a `Given`.

**When — one command or request.** Exactly one `When` per scenario. It is a command
(`SyncGmail`), an HTTP request (`POST /api/gmail/sync`) or a page read (`GET /inbox`). A second
command belongs in its own scenario whose `Given` includes the events the first would have
produced — that is what makes each scenario independent and its failure readable.

**Then — the response or the page, and the events.** A `Then` asserts on three kinds of things and
nothing else:

- the *response* (status, fields — `the response includes:`) or the *rendered page* (`the page
  "/inbox" shows:`, §3);
- the *events appended* by the command (`these events were recorded:`, matched by name and the
  fields listed; `nothing else was recorded` when the absence matters);
- a *refusal*: `Then the request was refused with "…"` and no event.

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
| `the founder's mailbox holds these threads:` (table) | What Gmail holds for the founder. | `MailboxSynced` |

## When

| Phrase | Meaning | Command |
|---|---|---|
| `Gmail finished syncing at {string}` | Runs a Gmail sync to completion at that instant. | `SyncGmail` |
| `the founder opens {string}` | GET of that path as the founder. | `GET` |

## Then

| Phrase | Meaning | Event |
|---|---|---|
| `these events were recorded:` (table `event`, fields…) | The command appended these events, matched by name and the listed fields. | |
| `the page {string} shows:` (table `label`, `value`) | The server-rendered page lists these labels with these values. | |
| `the thread {string} was resolved` | A `ThreadResolved` for that thread was appended. | `ThreadResolved` |
```

- **Event** (under Given and Then): the event the phrase appends or expects — `PascalCase`, past
  tense (`MailboxSynced`, `ThreadResolved`). **Command** (under When): what the phrase sends.
  A generic phrase (`these events were recorded:`) leaves the cell empty; the events are in its
  table.
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
  end

  def recorded = EventStore.since(@mark)   # Then: the events the command appended
  attr_reader :response
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
  rows = recorded.map { |e| { 'event' => e.class.name }.merge(e.to_h.transform_keys(&:to_s)) }
  table.hashes.each { |expected| expect(rows).to include(a_hash_including(expected)) }
end

Then('nothing else was recorded') do
  expect(recorded.size).to eq(@matched.to_i)
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
- `Then` compares the events *since the `When`* with the expected ones, by name and the listed
  fields only; extra fields are ignored, an extra event is caught by `nothing else was recorded`.
- Integrations are events: Gmail is `MailboxSynced`, a clock is `it is …`. The real adapter is
  tested by a contract test outside the corpus.
- The database is a transaction per scenario (DatabaseCleaner or an in-memory store); the corpus
  runs in the warm `nucleus-bdd` container on every file change and finishes in seconds.
- On a failure, print the specification, not the stack: the `Given` events, the `When` command, the
  expected and the actual `Then` events, side by side.

## 5. Writing a change

The author writes `features/*.feature`, `features/NEW_STEPS.md` and `specs/**/spec.md`; the
`#### Scenario:` titles in the spec are identical to the scenario titles (the join key).

1. Name the command the change introduces or alters; one scenario per outcome of that command
   (happy path, each refusal, each branch of the projection).
2. Write the `Given` as the events the outcome depends on — reuse `STEPS.md` phrases, add the
   missing ones to `NEW_STEPS.md` with their event.
3. Write the one `When`.
4. Write the `Then` as the events appended and the response or page a person sees. If the scenario
   needs something a page does not show and no event carries, that is a missing event — add it.
5. Read the scenario back as a sentence: "Given these things happened, when this was asked, then
   these things happened and this is what the page shows." If it does not read, split it.

An initiative is sliced by command, not by layer: each slice pins the commands it introduces and
the events they produce, and a later slice's `Given` may use the events an earlier slice added.

## 6. What the Desk checks

- **Shape.** For every scenario (Background included): exactly one `When`, at least one `Then`, no
  `Given` after the `When`, no `When` after a `Then`, a first step that is a primary keyword, and
  every catalogued phrase used under the section it sits in. A departure shows as an *off shape*
  pill with the reasons on the scenario card. A change the sandboxed **author** proposes is refused
  with the same messages before anything is moved into the worktree; a hand-written change is only
  marked, the owner decides.
- **Specification line.** Each scenario card shows `Given events → When command → Then events`
  from the catalogs' Event / Command column; the Phrases tab shows the column.
- **Catalog.** As before: every step is underlined by catalog status, a new phrase is approved by
  the owner, an extended meaning is flagged.

## 7. Moving an existing corpus

Nothing has to change at once. Add the Event / Command column to `STEPS.md` a phrase at a time;
scenarios with two `When`s split into two; `Given` steps that seed tables become the events those
rows came from (usually one phrase per integration). A scenario that cannot be phrased as events
plus one command is describing two behaviors — or a behavior nobody asked for.
