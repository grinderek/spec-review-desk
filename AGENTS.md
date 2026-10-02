# Developing Spec Review Desk

Use `features/*.desk.yaml` for product rules an owner needs to read and approve: workflows,
observable state transitions and business gates. Keep each rule readable; use a small case table
for meaningful variants. Do not translate every test into a contract or add DSL syntax for a
technical assertion. The language is described in `docs/method/desk-dsl.md`.

Use ordinary TypeScript integration tests for file formats, migration, concurrency, malformed input
and protocol details. Prefer real HTTP, disk and Git boundaries. Reuse `server/testing/review-world.ts`
for review fixtures. Avoid repeating the same behavior in DSL and implementation tests; keep
browser and compiler checks. Technical tests include focused parser and data-integrity checks;
do not remove valuable checks just to eliminate the unit-test label. The main application workflows
now have owner contracts; see `docs/method/testing.md` for the coverage boundary.

Start an OpenSpec change with `schema: behavior-driven`, put proposed contracts under `features/`
and keep `specs/**/spec.md` titles equal to those contracts. Use stable scenario ids. Do not rewrite
approved contracts to make an implementation pass.

Given facts prepare prior history and environment; When executes one public command; Then checks
new approval-journal events and public responses. Use response bindings for generated values and subsequent
GET observations for persisted state. Keep domain adapters small and add them for operations,
not scenario wording. Discussion, decision and agent-run state retains its existing persistence.

Run `npm test`, `npm run typecheck` and relevant browser checks. `npm run desk` opens this repository
with its local contract runner. Technical checks remain part of `npm test` even though the owner
reviews only the product corpus in Desk.

Desk owns review.yaml, review.events.jsonl and decisions.md. Agents must not forge approvals or
edit their history. Scenario, phrase and whole-change approvals project from review.events.jsonl;
other review fields still use YAML. Use the existing serialized update path for mutations.
