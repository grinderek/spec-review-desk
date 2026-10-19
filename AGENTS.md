# Developing Spec Review Desk

Use `features/*.desk.yaml` for product rules an owner needs to read and approve: workflows,
observable state transitions and business gates. Keep each rule readable; use a small case table
for meaningful variants. Do not translate every test into a contract or add DSL syntax for a
technical assertion. The language is described in `docs/method/desk-dsl.md`.

Write or restore standalone unit and technical integration tests only when the owner explicitly
requests them. A request to implement or fix a feature does not authorize adding tests. Do not
create `*.test.ts` / `*.test.tsx` files on your own initiative. Vitest, its configuration and commands
remain available for owner-requested tests; the previous suite stays deleted. Develop behavior
through the compact owner contracts, existing browser workflows, compiler checks and targeted
manual verification. Do not reproduce deleted assertions in DSL, browser tests, smoke scripts or
adapters without an explicit owner request. Add a contract only for a meaningful product rule;
keep adapters focused on setup and public operations. See `docs/method/testing.md`.

Start an OpenSpec change with `schema: behavior-driven`, put proposed contracts under `features/`
and keep `specs/**/spec.md` titles equal to those contracts. Use stable scenario ids. Do not rewrite
approved contracts to make an implementation pass.

Given facts prepare prior history and environment; When executes one public command; Then checks
new events in the selected review, initiative or verification journal and public responses. Use response bindings for generated values and subsequent
GET observations for persisted state. Keep domain adapters small and add them for operations,
not scenario wording. Approvals, discussions, owner decisions, patch lifecycle and Git receipts project
from the review journal. Initiative metadata, brief/input references, permissions and plans project
from the initiative journal and immutable blobs. Reviewer question and Apply requests, attempts,
stop intents and accepted results project from the review journal. Research, planner and author
runs project from the initiative journal. Verification requests, source manifests and report
acceptance project from `.spec-review/verification.events.jsonl`.

Run `npm test`, `npm run typecheck` and relevant browser checks. `npm run desk` opens this repository
with its local contract runner. `npm test` runs the product corpus and any owner-requested Vitest tests;
an empty Vitest suite succeeds. `npm run test:self` checks execution through Desk itself.

Desk owns review.yaml, review.events.jsonl, decisions.md, initiative.yaml and initiative.events.jsonl. Agents must not forge approvals or
edit their history. Scenario, phrase and whole-change approvals project from review.events.jsonl;
discussions, decisions, patches and reviewer sessions also project from that journal. YAML and
runtime JSON projections are derived views. Immutable runtime receipts are transport evidence;
their accepted business lifecycle belongs to the scope journal. Use explicit commands and the
serialized scope writer for mutations. Background observers must use `withDetachedReviewLocks`
so they do not borrow the caller's AsyncLocalStorage lease after it returns.
Execution admission and Git effects acquire the shared worktree lease before scope locks and
check conflicting review, initiative and verification work. Only a verified receipt confirms an
external effect. Apply requires a confirmed Git receipt for the current whole-change approval.
Replay must never repeat external effects. Recovery observes the existing attempt; an unknown
outcome requires explicit owner action and proof that the previous processes/container are inactive.
Verification uses one immutable result artifact per attempt, with complete case coverage and
source binding. Do not restore the shared last-run file or accept a partial report as success.
