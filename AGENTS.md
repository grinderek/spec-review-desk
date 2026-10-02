# Developing Spec Review Desk

Use `features/*.desk.yaml` for product rules an owner needs to read and approve: workflows,
observable state transitions and business gates. Keep each rule readable; use a small case table
for meaningful variants. Do not translate every test into a contract or add DSL syntax for a
technical assertion. The language is described in `docs/method/desk-dsl.md`.

Do not write standalone unit or technical integration tests for this repository. Do not create
`*.test.ts` / `*.test.tsx` files, restore Vitest or add a replacement technical test framework.
This is an explicit repository policy. Develop behavior through the compact owner contracts,
existing browser workflows, compiler checks and targeted manual verification. Do not move the
removed test cases into DSL, browser tests, smoke scripts or adapter assertions just to retain
them under another name. Add a contract only for a meaningful product rule; keep adapters focused
on setup and public operations. See `docs/method/testing.md`.

Start an OpenSpec change with `schema: behavior-driven`, put proposed contracts under `features/`
and keep `specs/**/spec.md` titles equal to those contracts. Use stable scenario ids. Do not rewrite
approved contracts to make an implementation pass.

Given facts prepare prior history and environment; When executes one public command; Then checks
new approval-journal events and public responses. Use response bindings for generated values and subsequent
GET observations for persisted state. Keep domain adapters small and add them for operations,
not scenario wording. Discussion, decision and agent-run state retains its existing persistence.

Run `npm test`, `npm run typecheck` and relevant browser checks. `npm run desk` opens this repository
with its local contract runner. `npm test` runs only the product corpus. `npm run test:self` checks
execution through Desk itself.

Desk owns review.yaml, review.events.jsonl and decisions.md. Agents must not forge approvals or
edit their history. Scenario, phrase and whole-change approvals project from review.events.jsonl;
other review fields still use YAML. Use the existing serialized update path for mutations.
