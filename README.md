# Spec Review Desk

Local review app for behavior-driven OpenSpec changes (`openspec/changes/*` with
`schema: behavior-driven`), across every git worktree of the repos in `config.yaml`.
Design: `docs/superpowers/specs/2026-09-23-spec-review-desk-design.md` (local, gitignored).

## Run

    cd tools/spec-review
    npm install
    npm start            # builds the UI, serves http://127.0.0.1:4600
    npm run dev          # server on :4600 + Vite on :5173 with hot reload

The server prints a one-time URL with `?t=<token>`. Open it; the token becomes an HttpOnly cookie.
Restarting the server issues a new token.

## What it does

- Renders each change's `features/*.feature` with decisions (`# Owner decision …`), author notes,
  tables and Examples; underlines each step by catalog status (STEPS.md / NEW_STEPS.md / neither).
- Approve / revoke / request changes per scenario and per new phrase. Approval is bound to the
  scenario's text hash: any edit sends it back to pending, with a diff since approval.
- Ask the change's agent (one `claude` session per change, opus, read-only tools). A proposed patch
  is applied only by "Apply & commit" → `docs(openspec): <change> — <summary> (owner decision)`.
- "Record approval" when everything is approved and every thread resolved; then "Apply" runs
  `/opsx:apply` detached with the allowlist from `config.yaml`. Stop, reply to `NEEDS_OWNER`,
  and re-apply scenarios whose corpus copy differs.
- Runs the cucumber corpus in the warm `nucleus-bdd` container on every file change.

State lives in `openspec/changes/<name>/review.yaml` (committed with each decision). Run logs live in
`<worktree>/.spec-review/` (added to `.git/info/exclude` automatically).
A patch commit's sha is written back into `review.yaml` after the commit that includes it, so
`review.yaml` shows as modified in `git status` until the next decision commits it.

## Security

Loopback only. Host and Origin are checked on every request; every `/api` call needs the session
cookie. The server spawns `claude` with write access for Apply — do not expose the port.

## Tests

    npm test             # vitest: server + ui helpers
    npm run coverage
    npm run e2e          # Playwright against a temp repo and a fake claude binary
