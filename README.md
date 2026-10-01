# Spec Review Desk

A local review app for behavior-driven OpenSpec changes across the git worktrees of configured
repositories. Codex researches a feature, proposes a slice plan, writes specifications, answers
review questions and implements approved changes. The owner approves behavior and records product
decisions before implementation starts.

## Run

Requires Node.js 24+, Git and Codex CLI 0.159.3+. Docker 25+ is needed for initiative agents and the
configured Cucumber runner.

```sh
npm ci
npm install -g @openai/codex@0.159.3
codex login
cp config.example.yaml config.yaml
# Set hubRoot, repos and initiativeBase for your repositories.
npm start                       # builds the UI and serves http://127.0.0.1:4600
# npm run dev                   # server :4600 + Vite :5173
```

Open the one-time URL printed by the server. Its token becomes an HttpOnly session cookie;
restarting the server issues a new token. The app listens on loopback only and checks Host, Origin
and the session cookie on API requests.

The checked-in `config.yaml` describes the original api/mobile/web workspace, including its existing
BDD worktree. Use `config.example.yaml` for another workspace. `model` defaults to `gpt-5.4` and
`codexBin` to `codex`. Select a model available to your account.

## Review and implementation

- Renders `openspec/changes/*` with `schema: behavior-driven`: Gherkin scenarios, author notes,
  owner decisions, tables and Examples. Step phrases are matched against `STEPS.md` and `NEW_STEPS.md`.
- Approvals are bound to text hashes. Editing an approved scenario or phrase makes it pending and
  shows a diff. Uncatalogued steps, unresolved threads and blocking decisions prevent readiness.
- Questions use one Codex thread per change. The reviewer has read-only file tools and proposes
  patches in its JSON reply. **Apply & commit** validates and commits a proposed specification patch.
- Decisions requiring the owner appear in the Decisions inbox. Scenario decisions are recorded in
  the agent's patch; change-wide decisions are written to `decisions.md` by the Desk.
- **Record approval**, then **Apply**, starts Codex detached. It reads the approved OpenSpec change,
  implements its scenarios, runs the permitted checks and commits. It can stop for owner decisions
  and resume after they are recorded or dismissed. Stop and re-apply remain available.
- The configured Cucumber corpus runs in its warm Docker container on file changes.

Every agent runs through `codex exec --json --output-schema <file>`. Replies are validated again on
the server, including rules that JSON Schema cannot express. An invalid reply is retried once in
the same thread. Codex assigns thread IDs; the Desk stores the returned ID for `codex exec resume`.
The CLI reports completed assistant messages rather than token deltas; the UI updates as those
messages and tool events arrive. A turn is successful only after `turn.completed`.

## New features and research

**+ New feature** creates `openspec/initiatives/<name>/` with a brief, inputs, decisions and a plan,
in an existing worktree or a new `.codex/worktrees/<name>` on branch `plan/<name>`.

1. Add a brief and inputs (Markdown, PDF or images).
2. The planner proposes 1–12 slices in dependency order. Edit or re-plan, then approve.
3. **Propose sN** runs an author against a clean room. The Desk vets the output, moves the resulting
   behavior-driven change into the worktree and commits it.
4. Review the change's scenarios and phrases, approve, and run Apply.

**Research** first exposes only `desk.search_web`: it returns Bing RSS result titles, URLs and
snippets, without opening result pages. Reading requires an owner-approved domain decision. The
read phase exposes `desk.read_web_page` and a restricted Playwright MCP browser for JavaScript
pages. Every redirect is checked; the browser's proxy permits only approved HTTPS domains. A
"search only" decision keeps page-reading tools unavailable. Research results are draft inputs
until accepted; previously read domains are retained in their provenance.

The method in [docs/method/bdd-event-sourcing.md](docs/method/bdd-event-sourcing.md) combines Gherkin
BDD, event sourcing and server-rendered full-stack checks. `Given` supplies prior events, exactly
one `When` sends a command/request, and `Then` describes the response/page and appended events.
The Desk flags departures and rejects off-shape author output. Planner and author rooms include
this method, the corpus, schema and repository instructions from `AGENTS.md`.

## Agent sandbox and authentication

```sh
npm run agent:build
npm run agent:login
npm run agent:auth-status
```

Docker initiative agents use ChatGPT subscription authentication by default. `agent:login` prints a
URL and device code: open the URL on your computer and sign in to the account whose plan includes
Codex. No API key is needed in this mode; usage consumes that account's Codex allowance. Enable
device-code login in your ChatGPT security settings if the login page requests it.

Credentials live in the private Docker volume `spec-review-codex-auth`, owned by uid 10001, rather
than in the project or the image. Each run has a separate Codex session directory and links its
`auth.json` to the shared volume. The pinned CLI writes refreshed credentials through that link.
An OS file lock serializes subscription agent sessions, including login/logout, to avoid concurrent
refresh-token rotation. Waiting for this lock counts towards the run timeout. Stop active agents before logging out or changing accounts. Authentication
commands accept `--config path/to/config.yaml` after `--` in the npm command. `npm run agent:logout`
removes the container login. Host Reviewer and Apply still use the host's `codex login`; sign in to
the same account there separately. Host history and credentials are never mounted into containers.

For separately billed API usage, set `sandbox.auth: api` in config.yaml and put `OPENAI_API_KEY` in
the gitignored `.env` next to it (`cp .env.example .env`). The key is passed privately to `codex exec`
as `CODEX_API_KEY`. The application never silently falls back from a subscription to paid API usage.
`sandbox.authVolume` selects a different named credential volume, for example for another account.

Codex has its native shell, web search, apps and plugins disabled. A scoped stdio MCP server
provides file reads, text search, PDF text and images. Reviewer, planner and research have no file
write tool; author writes only to `/work/out`. Apply has workspace writes and a command tool that
executes argv without a shell. Existing `applyAllowedTools` entries such as `Bash(git add:*)` remain
supported as command-prefix configuration; they do not launch Bash. Push, reset, rebase, rm, curl,
wget, ssh and scp stay denied even under a broader allowlist. Apply commands run on the host;
this allowlist is a command boundary, not a Docker sandbox.

Each initiative attempt runs as uid 10001 with a read-only root, resource limits and no Linux
capabilities, on internal networks behind per-run HTTPS proxies. Its room, output, separate Codex session store and subscription credential volume are mounted.
The agent proxy permits `chatgpt.com` and `auth.openai.com` in subscription mode (`api.openai.com`
in API mode), the search endpoint and approved read domains. The browser has a separate proxy/network and no key or host mounts. Its enabled MCP
tools are navigation, back, snapshot, click, wait and network requests. Teardown removes containers
and networks after completion, failure, timeout or stop; a run waiting for its owner keeps its
session for Resume. API keys and JWT credentials are redacted from logs and cause the run to fail.

The browser image is required only for a read phase. Without it research can search and then wait
for the owner to build the image. In a proxy environment, builds accept an optional BuildKit
`proxy_ca` secret; `NODE_IMAGE` can select a trusted mirror of `node:24-slim`.

## Migration from Claude

Existing specifications, reviews, decisions and git worktrees remain readable. Old Apply logs are
still decoded. Claude conversations cannot become Codex threads; missing threads are rebuilt from
files for questions. Finish or stop running Claude agents before switching runtimes. Retained
initiative runs waiting for their owner should be restarted under Codex rather than resumed with
an old Claude session ID.

Set `codexBin: codex`, an available Codex `model`, rebuild the agent image and run `npm run agent:login`. Existing
worktree paths in configuration need not move. New worktrees use `.codex/worktrees`. Room assembly
prefers `AGENTS.md` and `.agents/rules/testing.md`, with legacy `CLAUDE.md` and
`.claude/rules/testing.md` accepted as migration inputs.

State lives in `review.yaml`, `initiative.yaml` and `decisions.md`, next to the specifications.
Run logs and temporary files live under gitignored `.spec-review/`. A patch commit SHA is written
back to `review.yaml` after that commit, so it can remain modified until the next decision commits it.

## Developing the Desk with Desk DSL

The experimental YAML contract corpus in [features/](features/) runs through real HTTP handlers
and review approval event history. `npm run test:spec` executes it without an LLM; `npm run desk`
opens this repository in the Desk using `config.desk.yaml` and its local runner. Proposed contracts
are in `openspec/changes/try-desk-dsl` for owner review. The UI shows YAML, event/command summaries,
hash-bound approvals and verification results. Gherkin projects remain supported.

See [the language and migration boundary](docs/method/desk-dsl.md). Scenario, phrase and whole-change approvals are
replayed from `review.events.jsonl`; discussion, decision and agent-run state keeps its existing storage. `npm test` runs
both the DSL corpus and the remaining legacy checks. Only checks replaced by the corpus are removed.

## Checks

```sh
npm run typecheck
npm test
npm run coverage
npx playwright install chromium
npm run e2e
npm run smoke:codex
npm run smoke:agent-auth # offline Docker credential/locking check; build the image first
```

Vitest and Playwright use a fake Codex emitting native thread/item/turn JSONL, fake OpenSpec and
FakeSandbox. Browser tests cover review, decisions, planning, authoring and live updates; the
research search/domain-approval lifecycle is covered by server tests rather than browser tests.
`smoke:codex` runs the real CLI against a local Responses API fixture, checks an actual scoped MCP
call, JSON Schema output and thread resume, and requires no API key or paid model request. It does
not verify live OpenAI authentication or model behavior.
