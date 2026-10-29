# Spec Review Desk

A local review app for executable behavior contracts across the Git worktrees of configured
repositories. Codex researches a feature, proposes a slice plan, writes specifications, answers
review questions and implements approved changes. The owner approves behavior and records product
decisions before implementation starts.

## Run

Requires Node.js 24+, Git and Codex CLI 0.159.3+. Docker 25+ is needed for initiative agents and
Compose runners. Review and local verification runners work without Docker.

```sh
npm ci
npm install -g @openai/codex@0.159.3
codex login
npm start                       # builds the UI and serves http://127.0.0.1:4600
# npm run dev                   # server :4600 + Vite :5173
```

Open the one-time URL printed by the server. Its token becomes an HttpOnly session cookie;
restarting the server issues a new token. The app listens on loopback only and checks Host, Origin
and the session cookie on API requests.

The checked-in `config.yaml` opens this checkout without a verification runner. `npm run desk`
opens it with the local Desk DSL runner. `model` defaults to `gpt-6.1-sol`, `reasoningEffort` to
`high`, and `codexBin` to `codex`. Select models available to your account.

## Connect a project

Keep each workspace's configuration, Compose overlays and runtime settings in that workspace.
One Desk installation can open different repositories without editing its own files:

```sh
cp /path/to/spec-review-desk/config.example.yaml /path/to/project/spec-review.yaml
npm --prefix /path/to/spec-review-desk start -- --config /path/to/project/spec-review.yaml

# Select the same configuration for development or container authentication:
export SPEC_REVIEW_CONFIG=/path/to/project/spec-review.yaml
npm --prefix /path/to/spec-review-desk run dev
npm --prefix /path/to/spec-review-desk run agent:auth-status
```

`--config` takes precedence over `SPEC_REVIEW_CONFIG`; otherwise Desk reads `config.yaml` in its
working directory. Use an absolute path with `npm --prefix`, which runs scripts in the Desk checkout.
Restart the server to switch workspaces. `npm run desk` always selects `config.desk.yaml` explicitly.

For a single repository the example works in its root with `hubRoot: .` and
`repos: [{ name: project, path: . }]`. For several repositories set `hubRoot` to their common parent
and list each name and path. `hubRoot` defaults to the configuration's directory; repository paths
and runner `worktree` paths resolve from it. Compose `files` and `sandbox.envFile` resolve from the
configuration's directory. Paths may also be absolute. No particular repository name, language,
directory layout or branch name is required. `initiativeBase` defaults to `HEAD`; set an explicit
Git ref when initiatives should branch from a fixed integration branch.

Desk discovers native packages under each Git worktree's `desk/changes/<name>/`. Each package has
`change.yaml` with `version: 1` and `kind: behavior-driven`, plus executable contracts under
`features/`. Gherkin scenarios require `@id:<stable-id>`; Desk DSL scenarios require `id`.
The complete relative contract path and stable id form the key, such as `billing/approve.desk.yaml::approve`.
Titles are display text. Proposal, design and task documents are optional; the Contract docs tab
renders documentation from the executable contracts.

`runners` is optional; configure local or Compose verification for the project's toolchain.
Each attempt writes Desk or Cucumber message envelopes to its supplied `DESK_RESULT_FILE` or
`{resultFile}` argument. Desk captures the complete result in an immutable receipt, bound to the
attempt and exact source manifest. The example config documents both runner modes.

Workspace usage logs live in `.spec-review/usage` next to the selected config. Credentials default
to `.env` next to it, while container subscription credentials use `sandbox.authVolume`. Configure
different volumes when workspaces need different accounts. Review and initiative state stays with
the specifications in the target worktrees.

`agents` overrides the model and/or reasoning effort for `research`, `planner`, `author`,
`reviewer`, and `apply`; omitted fields inherit the top-level settings. The supplied configs use
Sol/medium for review questions, and Sol/high for planning, research, specification authoring
and implementation. These are starting profiles, not an evaluated quality ranking.
Luna/medium is a candidate for narrowly scoped extraction or summaries; none of the current roles
is limited to those operations, so it is not the default for an entire role. Supported effort
values are `low`, `medium`, `high`, `xhigh`, and `max`; effort is passed explicitly to Codex.
Restart the Desk after editing profiles. Future launches, retries and resumes use the new settings;
an already running agent keeps its existing model and effort.

## Review and implementation

- Renders native `desk/changes/*` packages: executable contracts, generated documentation, author notes,
  owner decisions, tables and Examples. Step phrases are matched against `STEPS.md` and `NEW_STEPS.md`.
- Scenario approvals are bound to semantic hashes. YAML formatting preserves approval; changed
  expectations require approval again. Uncatalogued steps, invalid packages, unresolved threads
  and blocking decisions prevent readiness. Whole-change approval also requires a confirmed Git
  receipt for the current exact contract sources before Apply can start.
- Questions use one Codex thread per change. The reviewer has read-only file tools and proposes
  patches in its JSON reply. **Apply & commit** validates and commits a proposed specification patch.
- Decisions requiring the owner appear in the Decisions inbox. Scenario decisions are recorded in
  the agent's patch; change-wide decisions project into `decisions.md` from confirmed journal facts.
- **Record approval**, then **Apply**, starts Codex detached. It reads the approved native package,
  implements its scenarios, runs the permitted checks and commits. It can stop for owner decisions
  and resume after they are recorded or dismissed. Stop and re-apply remain available.
- The configured corpus runs locally or in a managed Compose container on file changes.

Every agent runs through `codex exec --json --output-schema <file>`. Replies are validated again on
the server, including rules that JSON Schema cannot express. An invalid reply is retried once in
the same thread. Codex assigns thread IDs; the Desk stores the returned ID for `codex exec resume`.
The CLI reports completed assistant messages rather than token deltas; the UI updates as those
messages and tool events arrive. A turn is successful only after `turn.completed`.

## New features and research

**+ New feature** creates `desk/initiatives/<name>/` with a brief, inputs, decisions and a plan,
in an existing worktree or a new `.codex/worktrees/<name>` on branch `plan/<name>`.

1. Add a brief and inputs (Markdown, PDF or images).
2. The planner proposes 1-12 slices in dependency order. Edit or re-plan, then approve.
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

## Durable state and recovery

Review business facts live in `review.events.jsonl`; initiative facts live in
`initiative.events.jsonl`. YAML, brief/input views and `decisions.md` are derived projections.
Verification and initiative creation use worktree journals under `.spec-review/`. Every stream is
strictly validated. Unsupported history and snapshot-only state are refused; no compatibility
import runs implicitly.

Commands record intent before starting an agent or Git effect. Runtime receipts record process
identity and captured results; the scope journal records their acceptance. Restart recovery
observes existing work and never blindly runs it again. Unknown outcomes block conflicting work
until the owner acts explicitly and prior processes or containers are proven inactive. New
worktrees use `.codex/worktrees`; logs, receipts and private content artifacts use `.spec-review/`.

## Developing the Desk with Desk DSL

The YAML contract corpus in [features/](features/) runs through real HTTP handlers
and review approval event history. `npm run test:spec` executes it without an LLM; `npm run desk`
opens this repository in the Desk using `config.desk.yaml` and its local runner. Proposed contracts
are in `desk/changes/` for owner review. The UI shows YAML, event/command summaries,
hash-bound approvals and verification results. Gherkin projects remain supported.

See [the language and migration boundary](docs/method/desk-dsl.md). Scenario, phrase and whole-change approvals are
replayed from `review.events.jsonl` together with discussions, decisions, patches and reviewer/Apply runs. `npm test` runs
the product DSL corpus and any owner-requested Vitest tests. The old tests remain deleted;
AGENTS.md permits writing or restoring tests only at the owner’s explicit request. The owner corpus covers review, discussions, decisions, initiatives, research,
implementation and verification. See [the testing boundary](docs/method/testing.md).

## Checks

```sh
npm run typecheck
npm test
npm run test:self     # complete DSL corpus, plus matching contracts in the self-review change
npm run test:technical # currently empty; tests only at the owner’s explicit request
npm run coverage
npx playwright install chromium
npm run e2e
npm run smoke:codex
npm run smoke:agent-auth # offline Docker credential/locking check; build the image first
```

The contract runner and Playwright use a fake Codex emitting native thread/item/turn JSONL and
FakeSandbox. Browser tests cover review, decisions, planning, authoring and live updates; the
research search/domain-approval lifecycle is covered by the product contracts.
`smoke:codex` runs the real CLI against a local Responses API fixture, checks an actual scoped MCP
call, JSON Schema output and thread resume, and requires no API key or paid model request. It does
not verify live OpenAI authentication or model behavior.

### Local agent routing and usage

`routing.enabled` enables a host-side, loopback-only Kev router for Research and Apply.
It chooses Luna/medium, Sol/medium or Sol/high. Other roles keep their configured profiles.
Known high-impact tasks or descriptions over 12,000 characters choose Sol/high. Luna is
permitted only above `routing.minLunaProbability` (pilot default 0.55, not an accuracy claim).
Ambiguous Luna answers fall back to Sol/medium; missing, invalid or timed-out router replies
to Sol/high. The choice is persisted with the run and reused across retries and resumes.

The endpoint defaults to http://127.0.0.1:8009. Optional `routing.startCommand` is an argv
array for a local launcher. Desk starts it if unavailable and logs runtime output next to
its configuration in `.spec-review/usage/kev-runtime.log`. Each workspace selects its own
runtime launcher; example configs leave routing disabled.

Open **Agent usage & routing** above the workspace for cumulative totals and the latest
200 attempts, with a JSON export. The authenticated GET /api/usage serves the same data.
The full journal is `.spec-review/usage/agents.jsonl` next to the configuration. It records
roles, worktree/target, pinned model and effort, numeric routing evidence and policy reason,
task hash (not raw task), physical attempts and resumes, latency, tool starts and CLI-reported
input/cached/output tokens. Completions are deduplicated by attempt ID, including Apply
reattachment. Unfinished starts remain visible. Owner decisions retain the existing Decisions
tab and approval journal; routing never grants approval or changes scoped tools.

Actual billed cost and subscription allowance consumption remain unknown. The separate API
text-token estimate uses standard rates checked 2026-10-02, per million tokens:
Sol input $2 / cached $0.10 / output $10; Luna input $0.10 / cached $0.01 / output $0.50.
Sources: https://developers.openai.com/api/docs/models/gpt-6.1-sol and
https://developers.openai.com/api/docs/models/gpt-6-luna. Estimates omit cache writes, tool
fees, long-context, regional and service-tier surcharges; they are not invoices. Missing
usage and unknown rates remain unknown. Local Kev has no API charge; electricity is not
measured. Earlier runs are not retrospectively priced.
