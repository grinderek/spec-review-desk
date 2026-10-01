# Review migration to Desk contracts

The review area now has one executable behavior corpus. The following four Vitest files and their
25 remaining checks were removed after the contracts passed. Earlier scenario approval helper and
route checks were already replaced by `scenario-approval.desk.yaml`.

| Removed file | Behavior expressed in the DSL corpus |
| --- | --- |
| `server/routes/review.test.ts` | `review-actions`: requests for changes with an owner thread and agent reply, new/extended phrase approval, ready/unready approval commits, orphan drop/reassignment. `scenario-approval`: all archived review writes. |
| `server/readiness.test.ts` | `review-readiness`: approval gates, review versus Apply discussions, decision statuses, empty changes, join-key mismatches, invalid contracts and uncatalogued phrases. |
| `server/review-store.test.ts` | `scenario-approval`: empty defaults. `review-persistence`: Unicode keys, invalid projections, external metadata, concurrent approvals, message/patch/decision metadata, legacy YAML and journal compatibility. `review-actions`: moving/removing orphan entries. |
| `server/change-view.test.ts` | `review-views`: legacy features, phrase usage, decision provenance, obligation counts, orphan decisions and decision logs. `review-readiness`: ready views, partial parsing failures. `review-persistence`: invalid review files. Scenario lookup is exercised by review commands. |

Pure helper immutability and patch indexing checks are retired rather than translated into public
contracts. Discussion patch operations keep their HTTP coverage in `server/routes/threads.test.ts`;
decision mutations retain their own route tests. Other domains keep their existing tests until
migration. The browser suite verifies UI rendering, contract approval hashes and diffs.

Case tables keep variants under one reviewed rule. Each row executes in isolation; the corpus
contains 40 reviewed contracts with 65 executions. These counts describe the resulting corpus,
not a one-to-one conversion of implementation tests. New assertions cover the expanded approval
journal and old-state compatibility introduced by this migration.
