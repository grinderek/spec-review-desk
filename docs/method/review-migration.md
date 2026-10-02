# Review contracts and repository verification policy

The review corpus contains 14 rules in three files with 24 executions. It remains a compact set of
owner-readable rules: scenario and phrase approvals, semantic changes, readiness, discussions and
orphan handling. The complete application corpus contains 37 contracts / 50 executions.

The old standalone TypeScript suite, including review.integration.test.ts, has been removed.
AGENTS.md allows writing or restoring unit and technical integration tests only at the owner’s
explicit request. Vitest infrastructure remains available; the suite is currently empty. Do not
recreate deleted assertions in another format on your own initiative. Product rules remain in DSL; existing browser workflows and compiler
checks remain available. No replacement technical corpus was added.

Run `npm test` for the product corpus, `npm run test:self` for execution through Desk itself,
`npm run typecheck` for types and `npm run e2e` for browser workflows. See
[the repository verification policy](testing.md) for the boundary and coverage limits.
