# Product contracts and technical review checks

The owner corpus contains 14 rules in three files, reduced from 40 contracts in six files.
Case tables produce 24 executions instead of 65. A rule belongs here when a product owner needs
to understand and approve its behavior. Removing unit tests is not a goal by itself.

| Place | Responsibility |
| --- | --- |
| `features/scenario-approval.desk.yaml` | Approve/revoke a scenario; require new approval after a semantic change; preserve approval after formatting. |
| `features/review-actions.desk.yaml` | Request changes, approve/revoke phrases, approve a ready change, refuse an unready one, drop or reattach orphan reviews. |
| `features/review-readiness.desk.yaml` | Blocking decisions, unresolved discussions and proposed phrases gate readiness. |
| `server/review.integration.test.ts` | Legacy imports, replay and projection loss, escaped keys, external metadata, concurrent writes, corrupt state, invalid HTTP input, archival protection, parser errors, spec-title consistency, legacy views and approval Git artifacts. |
| Browser suite | Rendering, approvals, live updates and contract diffs. |

The technical tests use real disk, HTTP and Git with a shared review fixture. They are ordinary
TypeScript: no second declarative language and no technical scenario corpus for owner approval.
Git artifact assertions and observation bindings were removed from the DSL; response bindings
remain for generated ids and commits needed by product workflows.

The four old review route, readiness, store and change-view files remain retired. Their product
rules are expressed in the DSL, and their technical boundaries are exercised by the integration
file. Pure helper immutability and patch indexing checks were retired rather than mirrored.
Discussion patch and decision operations retain their separate route coverage. Other domains
keep their existing tests until deliberately migrated.

Run `npm test` to verify both kinds of checks. The local Desk runner executes the owner contract
corpus; passing that corpus alone does not claim technical or browser verification.
