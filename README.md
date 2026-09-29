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

## The method

`docs/method/bdd-event-sourcing.md`: classic Gherkin/Cucumber BDD plus two additions — every
scenario is an event-sourcing specification (`Given` = events that already happened, exactly one
`When` = one command or request, `Then` = the response or the server-rendered page and the events
appended), and full-stack checks read pages the server rendered, in process, without a browser.
The step catalogs carry an `Event` / `Command` column naming what each phrase appends, expects or
sends. It also covers refusals (a business "no" is an event, a rejected command appends none),
server-generated values, printing specifications and comparing events, projections in the
scenarios, event versioning and migrating a legacy corpus, after Rinat Abdullin's articles it
links. The document is copied into every planner and author room as `method/bdd-event-sourcing.md`.

## What it does

- Renders each change's `features/*.feature` with decisions (`# Owner decision …`), author notes,
  tables and Examples; underlines each step by catalog status (STEPS.md / NEW_STEPS.md / neither).
- Checks each scenario's shape — one `When`, `Given` before it, `Then` after it, phrases under their
  catalog keyword, events named in the past tense rather than as CRUD commands — and marks a departure *off shape* with the reasons; shows the scenario as
  `Given events → When command → Then events` from the catalogs' Event / Command column. An
  author's change that is off shape is refused at vetting.
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

    npm run agent:build   # builds spec-review-agent:2.1.280, spec-review-egress:2 and spec-review-browser:0.0.80
    claude setup-token    # then put CLAUDE_CODE_OAUTH_TOKEN=… into tools/spec-review/.env (gitignored)

Requires Docker ≥ 25: a research read phase starts the agent on two networks at once (two `--network`
flags on one `docker run`). A research read uses four per-run networks (`sr-net`, `sr-out`, `sr-bnet`,
`sr-bout`), other runs two, all from Docker's default address pools.

Each run gets its own `--internal` network (`sr-net-<run>`) and tinyproxy (`sr-egress-<run>`) that
lets only HTTPS through — CONNECT to port 443 of `api.anthropic.com` (plus approved research domains);
plain HTTP and every other port are refused (`FilterURLs On`, `^host:443$` filter lines). Each proxy
reaches out through its own per-run bridge (`sr-out-<run>`, `sr-bout-<run>`), never the shared default
bridge, so it cannot reach other containers. The agent
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
1.63.0 image, Chromium, as `pwuser`) on its own `--internal` network (`sr-bnet-<run>`) with every page
request through its own tinyproxy (`sr-bproxy-<run>`, same image and hardening as the agent's) whose
filter lists only the approved research domains — never `api.anthropic.com`. It shares no network with
the agent's proxy; a blocked host fails with `net::ERR_TUNNEL_CONNECTION_FAILED`. Read-only root with
tmpfs `/tmp` and `/home/pwuser`, no capabilities, `no-new-privileges`, pids/memory/cpu limits, no host
mounts, no token. The agent joins both networks and gets the browser as its one MCP server
(`--mcp-config` with `--strict-mcp-config`, `NO_PROXY=sr-browser-<run>`) and a minimal tool set:
navigate, navigate back, snapshot, click, wait for, network requests; the script-evaluation tools,
file upload, screenshots and form input stay denied. Navigation: `file:` URLs are blocked by the MCP
server and `javascript:` URLs abort, but a `data:` URL still opens a page that runs its own script —
@playwright/mcp 0.0.80 has no option to block it (`--allowed-origins` does not cover `data:`, verified),
so, as for any page, the boundary is the browser proxy: HTTPS to the approved hosts only. The search
phase, the planner and the author never get it.
The browser, its proxy and its network are removed with the agent, the agent's proxy and the run
network — also on stop, timeout and failure. A JavaScript page usually loads its scripts from other
hosts (the Intuit docs need `uxfabric.intuitcdn.net`, `plugin.intuitcdn.net` and
`static.developer.intuit.com` besides `developer.intuit.com`): the agent lists the failed requests and
asks for those hosts with another fetch-domains decision.
The secret scan fails closed: page text the agent reads (snapshots, tool results) is scanned too, so a
page that shows an `sk-ant-…` string — e.g. a sample key in API docs — fails the research run with the
rotate-your-token message even though your token did not leak (a false alarm; rotating is still the
safe answer when unsure).

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
