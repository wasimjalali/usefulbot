# Useful Bot: final v1 plan

Status: final planning baseline, 2026-09-12. Implementation has not started and live gates have not passed. [SPEC.md](SPEC.md) is the implementation contract. This document supersedes v0.1. The draft and counsel files remain unchanged.

## Goal

Ship a local personal agent on Vercel eve for one user on an Apple M1 Mac. The primary product is a macOS app. It supports conversation, bounded cross-session memory, web research and approved work in a dedicated workspace. OpenCode Go is the only v1 model upstream. There is no Vercel hosting and no usage-based model fallback.

The surface order is macOS, native mobile, then terminal. V1 includes the macOS app and a reduced-capability phone web client over Tailscale. The phone web client is an interim delivery of reachability, not a claim to have shipped native mobile. Native mobile is the first surface expansion after v1. A custom terminal interface follows it. The eve CLI is available earlier only for engineering checks.

Hermes parity is not a v1 acceptance criterion. Acceptance is seven days of the five named tasks below through the macOS app, with phone checks after the desktop gate. Hermes remains available during this trial.

## Verified facts and evidence boundaries

“Verified” below means observed in the supplied evidence or fetched primary source. It does not mean the integration has passed a live test. VERIFY entries have a named spike and a command in SPEC.md. Unknown technical facts have deterministic pass/fail consequences, not unanswered design choices.

| Fact | Evidence and disposition |
|---|---|
| The login-shell `node` is `~/.local/bin/node`, v22.23.1. `/usr/local/bin/node` is v24.11.1. | HY4's machine checks establish the first version; this synthesis reconfirmed the path and absolute Node 24 version. Use the absolute interpreter everywhere. |
| eve is filesystem-first, Apache-2.0 and public beta. Its source package reports 0.54.3; its repository requires Node 24+. | [eve package](https://raw.githubusercontent.com/vercel/eve/main/packages/eve/package.json), [repository package](https://raw.githubusercontent.com/vercel/eve/main/package.json). Pin `eve: 0.54.3`; VERIFY S0 checks the published artifact, peer dependencies and scaffold. |
| No app dependencies are installed in this repository. | Supplied HY4 recon and the current tracked-file inventory. None of eve's runtime behavior has been verified here. |
| OpenCode Go publishes `glm-5.3-flash` and `glm-5.3`; both use Chat Completions. Grok 4.6 uses Responses. | [Go endpoint documentation](https://opencode.ai/docs/go/), [live public catalog](https://opencode.ai/zen/go/v1/models). Choose the two GLM models to avoid a second protocol in v1. |
| Go requests should identify the client and preserve a conversation session header. Go can use a paid Zen balance if the owner enables it. | [Go client and usage documentation](https://opencode.ai/docs/go/). Send `User-Agent: useful-bot/1.0` and stable `x-opencode-session`; require “Use balance” off for the v1 trial. |
| The model catalog reports 1,000,000 context tokens and 131,072 output tokens for each chosen GLM model, and S1 measured both aliases accepting far more than the v1 policy window. | [Flash catalog](https://raw.githubusercontent.com/anomalyco/models.dev/dev/models/zhipuai/glm-5.3-flash.toml), [GLM catalog](https://raw.githubusercontent.com/anomalyco/models.dev/dev/models/zhipuai/glm-5.3.toml). S1 on 2026-09-12 accepted 937,684 input tokens on `workhorse` and 929,563 on `reviewer` with no rejection, so the catalog is not the binding constraint. v1 policy is a 131,072-token operating window with a 4,096-token output cap, both far inside the measured floor. The true ceiling above 937k tokens is unmeasured and is not claimed. |
| The local Codex catalog lists five visible model IDs and two hidden IDs. Default context is 272,000 with 95% effective context, or 258,400 tokens. GPT-5.5's maximum is 272,000; the other visible models list 872,000. | [local catalog](../research/codex-model-catalog.json). Maximum does not imply enabled capacity. Hidden IDs never become aliases. No Codex model is enabled in v1. |
| Codex app-server is an agent protocol with threads, turns and tool requests. | All four counsel reviews, local injected-instruction fields and [official app-server documentation](https://learn.chatgpt.com/docs/app-server). Its presence is not proof of a LanguageModel-compatible bridge. |
| Docker and microsandbox were absent in the machine recon. A VM must not be inferred from Apple Silicon support. | HY4 recon corrects v0.1. VERIFY S3 records the selected backend and tests its actual isolation. `just-bash` is treated as non-VM. |
| Authored tools can access the agent runtime's environment. An agent router token is therefore a usable quota capability. | Muse and HY4 findings, adopted threat model. Separate processes reduce accidental provider-key exposure but do not isolate processes running under one macOS user. |
| eve auth and approval hooks are exported, but session identity propagation, replay and cancel behavior need local proof. | [auth source](https://raw.githubusercontent.com/vercel/eve/main/packages/eve/src/public/channels/auth.ts), [approval exports](https://raw.githubusercontent.com/vercel/eve/main/packages/eve/src/public/tools/approval/index.ts). VERIFY S2 and S3 gate deployment. |
| Tailscale Serve can front a local service with tailnet HTTPS. | [Serve documentation](https://tailscale.com/docs/features/tailscale-serve). VERIFY S4 tests the actual ACL, phone identity and Funnel-off configuration. |
| Keyless search is verified working from this machine, with no key, account or signup. | Direct probe 2026-09-12: `POST https://api.firecrawl.dev/v2/search` with no API key returned HTTP 200 in 1.2s, body shape `{success, data:{web:[{url,title,description}]}, creditsUsed, id}`, and the hosted keyless MCP endpoint handshakes (firecrawl-fastmcp 3.24.1). The response carries no rate-limit headers, so 429 is the only limit signal and our own caps stay conservative. Keyless access still binds the operator to Firecrawl's terms and to target `robots.txt`. |

The supplied reviews disagree about whether to reuse Codex threads and whether a macOS wrapper belongs in the smallest release. The fixed constraints decide both: fresh threads in the later spike, and a working macOS wrapper in the first product milestone.

## Architecture

1. A Swift WKWebView macOS app loads the authenticated loopback Next.js chat. The shell stores its device credential in Keychain and establishes an HttpOnly browser session. It also presents local approvals.
2. One Next.js process serves the shared UI and authenticated browser-facing API. It proxies authenticated eve protocol requests to one loopback eve runtime. It never forwards a client-supplied profile or model identity as authority.
3. eve owns conversation history, compaction, tool execution and reviewer delegation. The root is pinned to `workhorse`; the single read-only reviewer is pinned to `reviewer`. Phone sessions have a separate immutable reduced-tool profile.
4. One router binds only `127.0.0.1:4319`. Its OpenCode adapter is an in-process module. It exposes Chat Completions, filtered model metadata, bounded search and health/accounting endpoints. It owns provider credentials, per-caller allowlists and persistent quota counters.
5. Markdown under `~/.useful-bot/memory/notes/` is memory truth. A rebuildable SQLite FTS5 index supports deterministic retrieval. At most 2,048 conservatively counted tokens of persistent memory can be model-visible per turn, including memory-tool results.
6. Tailscale Serve fronts only the phone-enabled Next.js routes. Next and eve bind `127.0.0.1:4320` and `127.0.0.1:4321`. Neither the router nor raw eve listener is published. The tailnet ACL admits only the owner's selected phone to the Mac's Serve HTTPS listener. Funnel is off.
7. Three launchd user agents supervise router, eve and web. The existing Tailscale service remains responsible for Serve. A sleeping Mac is unavailable; supervision restores service after wake and login, not while hardware is asleep.

Loopback addresses above are local application constants. The real tailnet hostname, device addresses and account identities stay in owner-supplied runtime configuration outside the repository.

## Decision table

| ID | Final decision | Reason supported by counsel |
|---|---|---|
| D1 | OpenCode Go is the only v1 LanguageModel upstream. | All four found the Codex bridge load-bearing and unproved. Removing it bounds the release. |
| D2 | Own a small router, one process with adapter modules. | All four favored one process. “Proven translators” named no actual component and is removed. |
| D3 | `workhorse = glm-5.3-flash`; `reviewer = glm-5.3`. | HY4's two-alias minimum plus public endpoint evidence. Both fit one Chat Completions adapter. Live failure blocks that alias; it never causes a silent model substitution. |
| D4 | Pin the root and reviewer for the entire turn. No step-level model selection. | Unanimous cache, accounting and context-window findings. Stable session headers preserve the upstream conversation identity. |
| D5 | No automatic fallback in v1. A desktop user may explicitly start a new read-only reviewer turn after a failed workhorse turn. | GLM and Grok prohibit mid-stream replacement. A visible new turn avoids replaying side effects. A reviewer outage does not promote the workhorse into a reviewer. |
| D6 | Deliver the working WKWebView shell in Phase 1 before memory expansion or phone access. | HY4 and Grok caught the priority inversion. The web UI is the shell's implementation dependency, not a separate browser-first launch. |
| D7 | Markdown truth plus Node's SQLite FTS5 index; explicit memory budgets and atomic writes. | Muse, GLM and HY4 identify cross-session scope, concurrency and retrieval problems. A small bounded index avoids a future 10,000-note scan without a database service. |
| D8 | Default this machine to non-VM mode until S3 proves a real VM. Every bash and write_file call requires local approval in non-VM mode. | HY4 disproved assumed microsandbox installation. A backend failure never silently lowers permissions. |
| D9 | Distinct device tokens, router caller tokens, session ownership and a phone tool allowlist. | Muse and HY4 show why one shared tailnet bearer is a remote-shell vulnerability. |
| D10 | The only model credential is the OpenCode Go key, owner-installed in Keychain and loaded only by the router bootstrap. Search needs no credential at all (keyless Firecrawl). No repository credential files and no key-install script. | Fixes v0.1's contradiction between `router/.env` and secret discipline, and the keyless search decision removes the second credential the plan used to need. Agent capabilities remain reachable and are capped rather than falsely described as secret. |
| D11 | Keyless Firecrawl search behind a bounded router endpoint, plus constrained public-HTTPS fetch. No search credential exists anywhere, so there is nothing to leak or rotate. | Owner decision 2026-09-12: free and keyless. Muse, HY4 and Grok still require the bounded provider endpoint, the credential boundary and the quota rule, all of which this keeps. |
| D12 | Absolute Node 24 interpreter, production builds and launchd from the first desktop milestone. | HY4's PATH finding and every review's missing-supervision finding. |
| D13 | One deterministic contract/eval suite plus live model cases and a seven-day task trial. | HY4 asks for named cutover tasks; all reject “a text reply worked” as sufficient proof. |

## Corrected build order and per-task gates

Command names here are defined in SPEC.md. They are required future implementation commands, not assertions that they exist today. Package installation requires the owner's standing approval gate. Scaffolding uses an isolated temporary directory, never `eve@latest init .` in this repository.

### Phase 0: prove compatibility and the safe desktop path

| Task | Deliverable | Verification gate |
|---|---|---|
| S0 | Pin Node and eve; inspect a temporary pinned scaffold and the installed public types. | `verify:phase0 -- --case runtime` proves Node 24, eve 0.54.3, compatible SDK types, CLI flags and local build/start layout. Unknown exports block integration, not an internal-framework patch. |
| S1 | Prove both Go aliases, auth, reasoning transport and the operating window. | `verify:phase0 -- --case opencode` runs non-stream, stream, multi-step tool round trip, fragmented tool arguments, reasoning replay, stable session headers and the operating-window boundary: v1 policy is 131,072 tokens with a measured acceptance floor of 937,684. |
| S2 | Prove the real eve channel, ownership and cancellation. | `verify:phase0 -- --case eve` shows authenticated Mac session, one tool result, cancel propagation, reconnect without resubmission and no anonymous route. |
| S3 | Select sandbox backend and prove approval enforcement. | `verify:phase0 -- --case sandbox` names the backend, checks workspace/egress limits and proves deny, expiry, modified arguments and replay cannot execute bash/write_file. |

S0-S3 block the desktop release. A VM is not mandatory if non-VM approval tests pass. Codex is absent from this gate. S4 phone and S5 search are staged at their dependent phases.

### Phase 1: supervised macOS vertical slice

| Task | Deliverable | Verification gate |
|---|---|---|
| 1.1 | Loopback router, two aliases, caller allowlists, usage reservations and stream/error contract. | Router contract tests pass, including 401, 403, 429, malformed SSE, cancellation and restart-persistent caps. Both live aliases pass S1. |
| 1.2 | Root instructions, explicit core-tool allowlist and eve authenticated session handling. | One live desktop task reads a fixture, requests approval and writes only the approved bytes. An injected request cannot alter policy or read credentials. |
| 1.3 | Next.js chat plus Swift WKWebView app, device login, session list, stream, cancel and approval UI. | A live turn completes inside the macOS app. Reload resumes the same session. Rejected approval has zero side effects. No browser credential is placed in URL, JS storage or prompt. |
| 1.4 | Router, eve and web launchd units with health dependencies. | `verify:phase1` passes crash/restart, duplicate-process prevention and dependency-down tests. App shows unavailable status while dependencies fail. |

Phase 1 is the first usable product, on macOS. No native mobile or terminal product work may displace it.

### Phase 2: minimum daily usefulness

| Task | Deliverable | Verification gate |
|---|---|---|
| 2.1 | Memory note format, atomic store, FTS5 index, audience filtering, injection cap and local recovery snapshots. | Cross-session recall, conflict, index rebuild, expiry and 10,000-note retrieval tests pass. All memory paths collectively stay within budget. |
| 2.2 / S5 | Keyless Firecrawl search and public web_fetch with bounded results and SSRF defense. | A live query with no search key present returns attributable title/URL/snippet results; timeout/429 and private-address redirects fail visibly; no loopback/tailnet fetch succeeds. |
| 2.3 | One pinned reviewer with supplied-text-only input and no side-effect tools. | Its real model ID appears in metadata; seeded defect is found; it cannot delegate recursively or acquire desktop tools. |
| 2.4 | Stable prompt prefix and complete owner instructions. | Voice, to-do, secret refusal, approval, branch and verification-honesty cases pass `verify:phase2`. No bulk skill import or old-memory import. |

### Phase 3: phone reachability after the macOS gate

| Task | Deliverable | Verification gate |
|---|---|---|
| 3.1 / S4 | Owner-selected phone credential, scoped Tailscale ACL and Serve HTTPS. | Owner phone succeeds; an additional tailnet device, wrong token, spoofed identity and Funnel path fail. Listener audit shows no wildcard binds. |
| 3.2 | Reduced phone profile and session ownership on every API. | Phone has search, public fetch and approved-for-phone memory read/search only. Direct requests for bash, write_file, arbitrary local files, reviewer or approvals fail server-side. |
| 3.3 | Mobile-sized web chat and reconnect. | Real phone sends, streams, cancels and resumes its own session after network loss. Mac and phone cannot interleave turns in one session. `verify:phase3` passes. |

This is explicitly a web client. Native mobile follows v1, before custom terminal work.

### Phase 4: release verification and bounded cutover

| Task | Deliverable | Verification gate |
|---|---|---|
| 4.1 | Full suite, clean build and a live agent turn on the release revision. | Root and router `npx tsc --noEmit`, lint, contract tests, `eve eval`, Swift build and `verify:release` all pass with no skipped required case. |
| 4.2 | Restart, login, sleep/wake, quota exhaustion and memory recovery drills. | Readiness returns within 60 seconds after dependencies and unlocked login Keychain are available. No side effect is replayed without a new approval. |
| 4.3 | Seven consecutive days of named tasks. | At least 20 of 25 scored attempts succeed, every task succeeds at least four of five attempts and no safety gate fails. Record failures without claiming Hermes replacement. |
| 4.4 | Review and ship on a branch. | Run available owner-required Codex review plugins for critical changes; resolve high/critical findings. Commit conventionally, push, PR, review and merge only when green. No direct-main commit. Missing review tooling blocks merge, not local implementation. |

The 25 scored attempts are five each: answer a research question with two checked source links; remember and retrieve an owner preference in a fresh session; summarize a workspace Markdown file; make an approved small fixture edit and report verification honestly; review a supplied diff containing a seeded defect. Phone safety/reconnect checks are additional and do not replace macOS task attempts. Keep the old agents until this gate passes and Wasim chooses cutover.

## Resolved from counsel

| Finding | Resolution and attribution |
|---|---|
| Stateful Codex translated into stateless Chat Completions | All four drove D1. GLM and Grok's fresh-request reasoning prevails over Muse's session-reuse proposal. Later spike only; no v1 adapter or dependency. |
| Context windows incorrectly absent or assumed | HY4 supplied 258,400 effective Codex context and hidden-model exclusions. Its prose overgeneralized maximum context; the catalog's GPT-5.5 exception wins. Go windows are separately sourced and live-gated. |
| macOS stranded after trial | HY4 and Grok drove Phase 1. Counsel suggestions to cut the wrapper lose to the owner's fixed priority. |
| Agent can use router bearer and phone can become a shell | Muse and HY4 drove per-caller caps, alias allowlists, real channel auth and the non-delegating phone profile. Environment scrubbing helps but is not asserted to be isolation. |
| No microsandbox actually installed | HY4 drove explicit backend probing and universal non-VM bash/write approval. Muse's workspace tests and Grok's egress warning become required gates. |
| Cache destruction and silent fallback | All four drove static aliases; GLM and Grok drove visible new-turn-only retry with no automatic v1 fallback. |
| No memory concurrency/injection contract | Muse, GLM and HY4 drove FTS5, atomic writes and a hard cap. Grok's simplicity concern is addressed by Node SQLite with no database server or embeddings. |
| Missing lifecycle, concurrency and accounting | All four drove launchd, health, redacted request IDs and persistent quota reservations. GLM drove one-active-turn and session ownership rules. |
| Search provider omitted and scope inflated | Muse, HY4 and Grok drove the requirement for a real, bounded search provider; the owner's 2026-09-12 decision replaced the paid option with keyless Firecrawl. The explicit v2 list keeps its force: no schedules, integrations or skill migration enter the release. |

## Deferred to v2

- Native mobile client first, then a custom terminal TUI. Phone web access remains until native mobile passes the same auth/profile suite.
- Codex compatibility spike, and Codex delegation tool if the spike fails. No ChatGPT subscription dependency in v1.
- Grok/Responses and Anthropic-compatible protocol adapters, generic API keys, additional subscriptions and paid model APIs. Future paid inference follows AWS Bedrock, DigitalOcean and then Vertex preferences. No Azure AI Foundry product inference.
- Additional coder/researcher subagents, automatic fallback, model picker, step-level routing and parallel agent workflows. Step-level routing has no presumed future approval.
- Hermes memory migration, bulk skills, semantic embeddings, automatic memory summarization and knowledge ingestion.
- MCP including GitHub, schedules/digests, CLI bridges including gh/Aside/remindctl/imsg, messaging, browser automation and unattended host actions. App connectors left this list on 2026-09-15 through Composio; see `docs/plan/CONNECTORS-COMPOSIO.md`.
- VM installation or Docker provisioning, expanded network access and autonomous workspace writes.
- Menu bar controls, global hotkey, notifications, visual polish program, multimodal uploads, multi-user support and cloud hosting.

The later Codex spike is capped at one engineering day after v1. Pin the installed CLI version and generate its schema. A single long-lived app-server child must use one fresh thread for each completion request with the full eve history. Pass only if Useful Bot's system rules prevail over injected Codex instructions, eve executes a complete tool-call round trip, streaming and cancel are faithful, compacted history/retry/restart do not duplicate state and our code never opens `~/.codex/auth.json`. A text-only answer is insufficient. Failure of any condition means Codex is exposed later as an explicit eve delegation tool with Codex owning its own agent state, never as a model upstream. See SPEC.md for the exact gates.

## Execution and review pipeline

Owner decisions of 2026-09-12. Work runs in the implementing agent's harness, not in `dsh`. `dsh` is verified working headless and already points at OpenCode Go, but its per-call model selection is unverified, its default model returned a weekly-limit 429 on the first probe, and it is a `0.1.2-rc.1` build. It stays available as an optional executor. Both target models were verified through OpenCode Go on 2026-09-12: `opencode-go/deepseek-v4.1-flash` and `opencode-go/glm-5.3`.

| Role | Model and harness | When it runs |
|---|---|---|
| Executor | `opencode-go/deepseek-v4.1-flash`, one fresh process per task | Every task in every PR |
| In-PR adversarial review | DeepSeek, multiple fresh processes across angles, driven by subagents | After each PR's tasks land, before the gate |
| Pre-merge gate | `opencode-go/glm-5.3`, fresh process, skeptic brief | After the DeepSeek passes come back clean |
| Hard-spot adversarial | Grok 4.6 through the Grok Build CLI, not OpenCode | Only on auth, token handling, Keychain and channel-auth changes |

The loop: executor work, then DeepSeek adversarial passes, fix confirmed Critical and High findings, then the GLM 5.3 gate, and only a clean gate merges. The implementing agent merges on green and reports after each PR. Document-only changes skip the adversarial step, per the standing loop. If the Grok CLI is not authenticated when a hard-spot pass is needed, that pass falls back to an additional DeepSeek adversarial pass plus the GLM 5.3 gate, and the substitution is stated in the PR.

Implementation sequence after the original six PRs (the current plan is docs/plan/LAUNCH-PLAN.md):
stream real replies (GitHub PR 11), then the light-theme multi-bot shell UI,
then memory/approvals in chat, search + reviewer, launchd, then release
verification.

Delivery shape: six PRs, each ending in a working, verified increment.

| PR | Scope | Exit gate |
|---|---|---|
| 1 | Documentation baseline: plan, spec, review page, `.gitignore`, repository hygiene | Merged to `main` |
| 2 | Phase 0 spikes S0 to S3: Node 24 pin, pinned scaffold, both Go aliases with tool-call round trip, eve channel auth and cancel, sandbox backend and approval enforcement | `verify:phase0` green for all four cases |
| 3 | Router package and agent core: two aliases, per-caller tokens and caps, stream and error contract, instructions, core tools, launchd supervision | Router contract tests plus one live desktop task that requests approval and writes only approved bytes |
| 4 | macOS surface: Next.js chat plus the Swift WKWebView shell, device login, session list, stream, cancel and approval UI | A live turn completes inside the macOS app; reload resumes the session; a rejected approval has zero side effects |
| 5 | Daily usefulness: memory store with atomic writes and the FTS5 index, keyless search, the pinned reviewer subagent, stable prompt prefix | `verify:phase2` including the 10,000-note retrieval case |
| 6 | Phone reachability and release verification: scoped Tailscale ACL and Serve, reduced phone profile, full suite, restart and sleep/wake drills, seven-day scored trial | `verify:phase3` then `verify:release`, then the seven-day score |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection can spend the agent's router allowance. | Assume exposed capability. Router-enforced alias allowlists, persistent request/output reservations, aggregate caps, manual revocation and no secret-bearing host execution without approval. These bound damage; they do not eliminate it. |
| Host-approved bash can exceed application controls under the same user. | Approve every command in non-VM mode; show exact command, cwd and network intent. Never claim a same-user process boundary is a security sandbox. Deny credential and application-control paths. |
| eve beta APIs differ from draft examples. | S0-S3 compile and exercise the installed public API. No automatic upgrades or internal patches. Block the affected phase with the failed gate visible. |
| A model disappears or Go changes limits. | Validate public IDs at startup and contract-test on upgrades. Runtime 404 disables the alias; 429 opens a circuit. Unknown quota is displayed as unknown. No downgrade. |
| Local-first is mistaken for offline/private inference. | Explain in onboarding only where needed: prompts go to Go, search queries to Firecrawl and fetched sites receive requests. No sensitive memory import by default. |
| Mac sleep, logout or locked Keychain prevents service. | Honest unavailable UI, launchd after login and wake probes. No assertion of continuous availability while asleep. |
| Lost phone or overly broad existing Tailscale rules. | Revoke just that device; recheck additive ACL rules; default-deny tailnet test from another device. Remote enablement waits for S4. |
| Memory corruption or stale/injected content. | Markdown truth, atomic revisions, index rebuild, bounded local snapshots, expiry and untrusted-data handling. No silent note eviction. |
| Search requires a new paid account. | Owner chooses the spending ceiling. No paid provisioning or silent provider substitution. Search gate stays visibly incomplete until enabled. |

## Decisions for Wasim

Settled by the owner on 2026-09-12 and recorded here as fixed decisions, not open questions:

1. Dependency installation is approved. Search is keyless Firecrawl, so no search key, account or spending ceiling exists. The only model credential in the system is the OpenCode Go key.
2. Phone enrollment is delegated to the implementing agent: one device only, the owner's daily phone, enrolled at Phase 3 with a per-device credential in Keychain and a Tailscale rule scoped to that phone. The owner performs one tap at enrollment; no device identity enters the repository.
3. Delivery is six PRs, with the DeepSeek adversarial pass on every PR and the GLM 5.3 gate before each merge. The implementing agent merges on green.

Still the owner's call:

1. Whether to retire the old daily agents after the trial. Recommendation: keep them until every release gate and the seven-day score pass. No retirement or VM purchase is needed to implement v1.
2. Whether to authenticate the Grok CLI. The reserved hard-spot adversarial pass runs through the Grok Build CLI as specified, and that CLI is not authenticated on this machine (verified 2026-09-12: `grok models` reports "You are not authenticated"). Until it is signed in, hard-spot passes fall back to an extra DeepSeek adversarial pass plus the GLM 5.3 gate.
3. Whether to enable OpenCode Go balance spend if the weekly window becomes a blocker during execution. Default is off; a 429 pauses the affected alias and the PR waits for the window to reset.
