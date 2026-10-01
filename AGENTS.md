# Developing Spec Review Desk

Use the Desk DSL contracts in `features/*.desk.yaml` for new behavior. The language and first
adapter are described in `docs/method/desk-dsl.md`; the parser is `server/desk-dsl.ts`.
Start an OpenSpec change with `schema: behavior-driven` and put the proposed DSL under its
`features/` directory. Keep `specs/**/spec.md` scenario titles equal to the DSL scenario titles.
Use stable scenario ids; do not rewrite approved contracts to make an implementation pass.

Given facts set the prior event history and declared environment. When executes one command via
its public entry point. Then checks the exact count/order/types of appended events and the listed
public response fields. Add domain adapters for new commands and events, not step phrases.
The current adapter covers scenario review; other modules have not yet moved to event sourcing.

Run `npm run test:spec`, `npm run typecheck`, `npm run test:legacy` and relevant browser checks.
Replace a legacy test only when its behavior is exercised by a passing contract. Keep compiler and
build checks. Use `npm run desk` to review this repository with `config.desk.yaml`.

The Desk owns review.yaml, review.events.jsonl and decisions.md. Agents must not forge approvals
or edit their history. Scenario approvals are projected from review.events.jsonl; other review
state still uses YAML. Use the existing serialized update path for scenario review mutations.
