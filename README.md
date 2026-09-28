# Spec Review Desk

Local review app for behavior-driven OpenSpec changes (`openspec/changes/*` with
`schema: behavior-driven`), across every git worktree of the repos in `config.yaml`.
Design: `docs/superpowers/specs/2026-09-23-spec-review-desk-design.md` and
`docs/superpowers/specs/2026-09-24-spec-review-decisions-design.md` and
`docs/superpowers/specs/2026-09-24-spec-review-initiatives-design.md` (local, gitignored).

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
- Every agent replies with one JSON object (`claude --json-schema`, schema in `server/protocol.ts`),
  validated again on the server; an invalid reply is retried once in the same session, then shown
  with its issues and raw text.
- Questions only the owner can answer arrive as **open decisions** (Decisions tab inbox, thread
  cards, "decision open" pill, gate counter). A blocking decision keeps the change from being ready.
  A scenario decision is recorded by the agent's patch (`# Owner decision …`, `resolves`); a decision
  about the whole change is written by the Desk to `<change>/decisions.md` and committed with
  `review.yaml`. "+ Open decision" adds one by hand; decisions are dismissed, never deleted.
- "Record approval" when everything is approved, every thread resolved and no blocking decision
  open; then "Apply" runs `/opsx:apply` detached with the allowlist from `config.yaml`. An Apply run
  that needs the owner raises decisions; "Resume with decisions" continues it once they are recorded
  or dismissed. Stop, and re-apply scenarios whose corpus copy differs.
- Runs the cucumber corpus in the warm `nucleus-bdd` container on every file change.
- **+ New feature** starts an *initiative* (`openspec/initiatives/<name>/`: `initiative.yaml`,
  `brief.md`, `inputs/`, `decisions.md`) in a new worktree `plan/<name>` or an existing one. A
  sandboxed **planner** proposes a slice plan (edit, re-plan, approve); **Propose sN** runs a
  clean-room **author** that writes the slice as a behavior-driven change, vetted before it is moved
  into the worktree and committed. **Research** runs in two phases: WebSearch only, then WebFetch
  limited to the domains the owner approves in the initiative inbox; the result is a draft input
  until accepted. The Brief tab edits `brief.md` in place (Save commits it); an input's name (Inputs
  table, Research drafts) opens it in a viewer — Markdown rendered, a PDF or image inline — with
  Accept/Discard next to a draft.

## Sandbox (research, planner, author)

    npm run agent:build   # builds spec-review-agent:2.1.280, spec-review-egress:1 and spec-review-browser:0.0.80
    claude setup-token    # then put CLAUDE_CODE_OAUTH_TOKEN=… into tools/spec-review/.env (gitignored)

Each run gets its own `--internal` network (`sr-net-<run>`) and tinyproxy (`sr-egress-<run>`) that
lets CONNECT through only to `api.anthropic.com` (plus approved research domains). The agent
container is read-only, without capabilities, as uid 10001, and sees only its room (read-only), its
output directory and its session store under `<worktree>/.spec-review/runs/<run>/`. The token is
passed through a per-run env file, never logged or served; every run's output is scanned for it.
The sandbox is ready with the agent and egress images and the token; the browser image is reported on
its own (the Research tab shows its build hint). Without it research still searches, but a reading
phase never starts: Resume answers 409 `browser_unavailable`, and a run that would continue into it
on its own waits for the owner (needs owner, "… npm run agent:build, then Resume").

**Research browser.** WebFetch returns pages that render with JavaScript empty ("Content truncated"),
so the research read phase (after the owner approved domains) also gets a headless browser:
`sr-browser-<run>`, the Playwright MCP server (`@playwright/mcp` 0.0.80 in the official Playwright
1.63.0 image, Chromium, as `pwuser`) on the run's `--internal` network with every page request through
the same egress proxy — it reaches only the approved hosts (a blocked host fails with
`net::ERR_TUNNEL_CONNECTION_FAILED`). Read-only root with tmpfs `/tmp` and `/home/pwuser`, no
capabilities, `no-new-privileges`, pids/memory/cpu limits, no host mounts, no token. The agent gets it
as its one MCP server (`--mcp-config` with `--strict-mcp-config`, `NO_PROXY=sr-browser-<run>`) and a
minimal tool set: navigate, navigate back, snapshot, click, wait for, network requests; script
evaluation, file upload, screenshots and form input stay denied. The search phase, the planner and the
author never get it. The browser is removed with the agent, the proxy and the network — also on stop,
timeout and failure. A JavaScript page usually loads its scripts from other hosts (the Intuit docs need
`uxfabric.intuitcdn.net`, `plugin.intuitcdn.net` and `static.developer.intuit.com` besides
`developer.intuit.com`): the agent lists the failed requests and asks for those hosts with another
fetch-domains decision.

Every sandboxed reply (planner/author/research) is requested with `claude --json-schema`; the real
CLI rejects a schema that carries a top-level `$schema` key (zod's `toJSONSchema` emits one), so
`REPLY_SCHEMA_ARGS` in `server/initiative-protocol.ts` strips it the same way `server/protocol.ts`
already does for `AGENT_REPLY_SCHEMA_ARG` — a test pins that no schema arg ever carries `$schema`.

`npm run e2e` exercises New feature → plan (**planner**) → approve → propose (**author**, including
stopping a hung run and proposing again) against `FakeSandbox` and the fake `claude`/`openspec`
binaries — no docker, no real agent. It does **not** cover **research**: no spec drives the Research
tab, its WebSearch/WebFetch phases, or the domain-approval decision flow — that coverage is still
outstanding. Task 21 (building the real images, running one real sandboxed run end to end against
the real `claude` CLI and docker) is a manual, one-time check outside the automated suite; see
"Task 21: MANUAL — the real sandbox" in
`docs/superpowers/plans/2026-09-24-spec-review-initiatives.md` (local, gitignored) before doing it.

State lives in `openspec/changes/<name>/review.yaml` (committed with each decision) and `decisions.md`. Run logs live in
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
