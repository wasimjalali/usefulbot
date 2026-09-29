# Useful Bot: a model-agnostic personal agent on eve (Plan v0.1)

**Status:** draft for counsel review. Not yet approved. No implementation until Wasim approves the final HTML.
**Owner:** Wasim Jalali. **Author of this draft:** Hermes (Grok/OpenCode harness).
**Repo:** `~/Desktop/useful-bot` (local only, git initialised on `main`, nothing committed yet).

> Note on location: the `plan` skill puts plans under `.hermes/plans/`. This one lives at
> `docs/plan/PLAN-v0.1.md` inside the repo instead, because the four counsel models read it with
> the repo as their working directory and it needs to be versioned with the project.

---

## 1. Goal

Build **Useful Bot**, a personal, model-agnostic agent that replaces Hermes, Grok Bot and OpenClaw
for daily use on this machine. It must run on a **macOS app** (primary), be reachable from a
**native mobile app** (second), and be usable from a **terminal TUI** (secondary). It must work
against flat-rate subscriptions first and provider APIs second, without per-token billing being the
default path.

Success is: Wasim stops reaching for Hermes for his daily work.

---

## 2. Verified context (evidence gathered, not assumed)

| Fact | Source |
|---|---|
| eve is Vercel's open-source agent framework, Apache-2.0, public beta | `github.com/vercel/eve`, `vercel.com/blog/introducing-eve` |
| eve npm version `0.54.3`, Node 24+ required, machine has 24.11.1 | `npm view eve version`, `node --version` |
| Agent = directory: `agent/{agent.ts,instructions.md,tools,skills,subagents,channels,connections,schedules,sandbox,hooks}`, `evals/` beside it | `eve.dev/docs/getting-started`, `/docs/agent-config` |
| Model config accepts an AI Gateway id string **or** a direct-provider `LanguageModel`; `createOpenAICompatible({baseURL,apiKey}).chatModel(id)` is the documented BYO-endpoint path | `/docs/agent-config`, AI SDK openai-compatible docs, working LiteLLM/Zuplo examples |
| Non-Gateway models need explicit `modelContextWindowTokens`; eve cannot look them up | `/docs/agent-config`, `github.com/vercel/eve/discussions/37` |
| `eve init --channel-web-nextjs` scaffolds a Next.js web chat; `eve add channel/web` adds it later; `withEve` + `useEveAgent` drive it | `/docs/reference/cli`, `/docs/guides/frontend/overview` |
| HTTP surface is `/eve/v1/*` (session, stream NDJSON, cancel, clear, compact, reset, health, info), auth via `eveChannel({ auth: [...] })`, helpers `localDev()`, `vercelOidc()`, generated `placeholderAuth()` | `/docs/channels/eve` |
| Default tools: `bash`, `read_file`, `write_file`, `web_fetch`, `web_search`, `ask_question`, `load_skill`, `connection_search`; opt-in `grep`, `glob`, `sleep`. `web_search` only appears for supported providers (Gateway uses Exa) | `/docs/concepts/built-in-tools` |
| Sandbox backends in priority order: Vercel → Docker → microsandbox → just-bash. Docker is **not installed** here; this is an **Apple M1**, so microsandbox is the local backend | `/docs/sandbox`, `uname -m`, `command -v docker` |
| Durability: sessions survive restarts, turns checkpoint at step boundaries, `defineState` gives session-scoped durable state | `/docs/concepts/execution-model-and-durability` |
| CLI surface: `init`, `dev`, `build`, `start`, `eval`, `traces`, `info`, `add <slot>`, `set`, `channels list` | `/docs/reference/cli` |
| OpenCode Go credential present; 32 model ids listed including `glm-5.3`, `glm-5.3-flash`, `grok-4.6`, `hy4-preview`, `muse-spark-1.3-contributor`, `kimi-k3`, `qwen3.8-max`, `deepseek-v4-pro` | `opencode models`, `opencode auth list` |
| Codex CLI 0.154.0, `auth mode: chatgpt`, catalog includes `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` | `codex doctor`, `codex debug models` |
| `grok` CLI 1.0.13 is installed but **not authenticated** (`grok models` says "You are not authenticated") | `grok models` |
| Grok 4.6 is available through OpenCode Go, so no separate xAI login is required | `opencode models` |
| OpenCode Go is published as an OpenAI-compatible key intended for third-party clients (Hermes, OpenClaw, Pi, Codex are named) | OpenCode Go plan docs and provider docs |

**Not verified yet, must be before implementation:** exact OpenCode Go base URL and auth header from
official docs (third-party READMEs claim `https://opencode.ai/zen/go/v1/chat/completions`; treat as
unconfirmed), the real context window of each model in the registry, and whether `codex app-server`
can serve a plain model turn cleanly.

---

## 3. Architecture

Three layers, each independently replaceable.

```
 Surfaces                Agent core (eve)                     Model layer (our router)      Upstreams
 --------------------    ---------------------------------     -------------------------     -----------------------
 macOS app               agent/instructions.md                 POST /v1/chat/completions     OpenCode Go  (sub, key)
  (WKWebView shell)  ->  agent.ts  (model + dynamic routing) ->  GET  /v1/models            ->  Codex app-server
 Next.js web chat        agent/tools/*                         alias registry:               (ChatGPT sub, OAuth
  (withEve,             agent/skills/*                          alias -> upstream + model     owned by the CLI)
    useEveAgent)         agent/subagents/*                       + context window            OpenAI-compatible APIs
 Terminal TUI            agent/channels/eve.ts (auth)            + reasoning effort            (DeepSeek etc, BYO key)
  (eve dev)              agent/schedules/*                       fallback chains             (later) more flat-rate
 Tailscale (phone)       agent/connections/* (MCP)                                             plans from the survey
```

**Why a router instead of pointing eve at each provider:** eve takes one model per agent (plus one
per subagent). Subscriptions are three different auth models: a plain API key (OpenCode Go), an
OAuth-owned-by-a-CLI session (Codex/ChatGPT), and ordinary keys (DeepSeek and friends). A single
local OpenAI-compatible surface absorbs all of that, keeps routing policy in one reviewable file,
and means a subscription swap never touches the agent.

**Why the router is a separate process on loopback:** it holds credentials. The agent, the web app
and the macOS shell never see a key. Router binds `127.0.0.1` only, requires its own bearer token
even locally, and is never exposed on the tailnet.

**Secret discipline (non-negotiable):**
- The router **never reads** `~/.codex/auth.json` or `~/.local/share/opencode/auth.json`. The Codex
  path talks to the official CLI (`codex app-server`), so ChatGPT OAuth stays owned by Codex, gets
  refreshed by Codex, and is never copied, cached or logged.
- OpenCode Go and provider keys are installed by Wasim through a hidden-paste script into
  `router/.env` (mode 600, gitignored). Never in a prompt, a doc, a commit or chat.
- No secret is ever written to the repo, the HTML review artifact or memory files.

---

## 4. Repo layout

```
useful-bot/
├── package.json                 # the eve app (root = agent app, per eve conventions)
├── tsconfig.json
├── README.md
├── .gitignore                   # .env, router/.env, .eve/, node_modules, .DS_Store
├── agent/
│   ├── agent.ts                 # defineAgent: router provider, default model, limits
│   ├── instructions.md          # persona + operating rules + memory discipline
│   ├── channels/eve.ts          # auth policy: localDev + tailnet bearer
│   ├── channels/web/            # Next.js chat app (eve add channel/web)
│   ├── tools/                   # web_search, memory, sandbox helpers, CLI bridges
│   ├── skills/                  # ported skill subset, lazy-loaded
│   ├── subagents/               # coder, researcher, reviewer
│   ├── schedules/weekly_digest.ts
│   ├── connections/github.ts
│   └── sandbox/sandbox.ts
├── router/                      # separate npm package, own lockfile
│   ├── package.json
│   ├── src/index.ts             # OpenAI-compatible HTTP surface
│   ├── src/registry.ts          # alias -> upstream, model, context window, effort
│   ├── src/upstreams/opencode.ts
│   ├── src/upstreams/codex.ts   # drives codex app-server over stdio JSON-RPC
│   ├── src/upstreams/compat.ts  # generic OpenAI-compatible BYO key
│   └── test/
├── macos/                       # Swift WKWebView shell (phase 5)
├── evals/                       # eve evals proving behaviour
├── docs/
│   ├── plan/PLAN-v0.1.md        # this file
│   ├── spec/                    # final spec after Astra synthesis
│   ├── counsel/                 # the four counsel reviews
│   └── research/                # catalog dumps, plan surveys
└── scripts/install-keys.sh      # hidden-paste key installer (no agent ever sees values)
```

The router is a sibling package, not an npm workspace: eve expects an app root at the repo root, and
workspace magic would fight that. Two lockfiles, one `npm run` script each. Simplicity over symmetry.

---

## 5. Design decisions

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| D1 | Local-first, loopback + Tailscale, no Vercel deploy | Subscription OAuth stays on the machine; re-serving subscription traffic from a cloud host is the documented line; no hosting bill | Vercel hosting (needs OAuth in the cloud) |
| D2 | Hybrid model layer: proven translators where they earn it, our own thin router for routing policy | The socket the agent talks to is stable, the Codex adapter is swappable | All-in-one OSS proxy (we inherit its auth handling); all-in-house (we re-implement OAuth refresh for no gain) |
| D3 | Codex path drives the **official CLI** (`codex app-server`), not the OAuth file | Tokens stay with Codex; refresh, sessions and identity stay official; matches OpenAI's sanctioned "sign in with ChatGPT in supported clients" line | Reading `~/.codex/auth.json` (duplicates a credential), spawning `codex exec` per turn (loses multi-turn session semantics) |
| D4 | OpenCode Go reached directly over HTTPS with its own key, installed into `router/.env` | Go is documented as an OpenAI-compatible key for third-party clients; simplest correct path | Routing through `opencode serve` (extra hop, translation work, no secret benefit vs D3) |
| D5 | Default model is a real workhorse through the router, per-task models via subagents and step-level selection | eve takes one model per agent; specialisation belongs in subagents | One static flagship model for everything (wastes quota) |
| D6 | macOS app is a WKWebView shell over the Next.js chat UI | Matches Wasim's existing macOS shell pattern, reuses the web UI, ships fastest | Native SwiftUI client (double implementation of a chat UI), Tauri (extra runtime for no benefit) |
| D7 | Build order: agent core + web UI, then wrap the macOS app | Nothing to wrap until the agent actually works | App shell first (pretty window with nothing behind it) |
| D8 | Memory is our own store (markdown + index), not an eve primitive | eve has durable session state but no cross-session memory | Waiting for an eve memory feature that does not exist |
| D9 | Sandbox: microsandbox on this M1, Docker not installed | eve's local fallback order; no Docker Desktop licence or daemon to manage | Installing Docker Desktop (a licence decision for Wasim, and not required) |

---

## 6. Phases and tasks

Each task is small enough to verify on its own. "Verify" is the acceptance gate: no task is done
because it was written, only because the check passed.

### Phase 0: prove the risky parts before building anything (spikes)

| Task | Do | Verify |
|---|---|---|
| S1 | `npx eve@latest init .` in the repo root, then `eve info` | `eve info` lists the discovered surface as JSON; `npm run dev` starts |
| S2 | Stand up a 30-line stub router returning a fixed OpenAI-shaped completion; point `agent.ts` at it via `createOpenAICompatible` with `modelContextWindowTokens` | A turn through `eve dev` returns the stub text. Proves the BYO-provider path end to end |
| S3 | Point the stub at real OpenCode Go, single non-streaming call from `curl` | Real tokens come back; confirm the official base URL and auth header from OpenCode docs, not from blogs |
| S4 | Prove the ChatGPT-subscription path: drive `codex app-server` over stdio from a throwaway script, one turn | A model reply for `gpt-6-astra`, with `~/.codex/auth.json` never opened by our code |
| S5 | Prove the sandbox boots without Docker (`microsandbox` backend), run `uname -a` inside it | Command output returns; backend named in the trace |
| S6 | Prove per-task model selection: one session, `step.started` handler returning a different model, or two subagents pinned to different models | Two different models demonstrably served one conversation (trace shows both model ids) |

**Gate:** all six pass, or the plan changes. No phase 1 work starts while S2, S3 or S4 is open.

### Phase 1: the model layer

| Task | Files | Verify |
|---|---|---|
| 1.1 Router skeleton: bind `127.0.0.1:4319`, bearer token required, `GET /v1/models`, `POST /v1/chat/completions` streaming and non-streaming | `router/src/index.ts` | Unit tests for token rejection and shape; `curl` smoke test |
| 1.2 Registry: alias -> upstream, upstream model id, context window, default reasoning effort, fallback chain | `router/src/registry.ts` | Test that an unknown alias fails loudly; registry validates every alias at boot |
| 1.3 OpenCode Go adapter (streaming, tool calls, reasoning passthrough) | `router/src/upstreams/opencode.ts` | Live call per alias in the registry |
| 1.4 Codex adapter over `codex app-server` (session reuse, streaming, error mapping) | `router/src/upstreams/codex.ts` | Live turn on `gpt-6-astra`; failure path surfaces, does not swallow |
| 1.5 Generic OpenAI-compatible adapter for BYO keys (DeepSeek and friends) | `router/src/upstreams/compat.ts` | Live call with one real key |
| 1.6 Key installer: hidden paste into `router/.env`, mode 600, prints length only | `scripts/install-keys.sh` | File exists, mode 600, gitignored, value never printed by the agent |
| 1.7 Model/context-window verification: real windows for every registry entry | `router/src/registry.ts`, `docs/research/model-windows.md` | Every alias has a documented, sourced number; no guesses |

### Phase 2: the agent core

| Task | Files | Verify |
|---|---|---|
| 2.1 `agent.ts`: router provider, default model, compaction threshold, session limits | `agent/agent.ts` | `eve info` clean; a turn runs on the default alias |
| 2.2 `instructions.md`: who Useful Bot is, Wasim's laws (no em dashes, branch discipline, secret refusal, verification honesty), memory discipline, when to load which skill | `agent/instructions.md` | A turn obeys three spot-checked rules |
| 2.3 Port the skill subset from `~/.hermes/skills`: `useful-design`, `adversarial-security-review`, `plan`, `github`, `aside-browser`, `macos-wkwebview-shells` | `agent/skills/*.md` | `eve info` lists them; a prompt that needs one triggers `load_skill` |
| 2.4 Memory: `memory` tool (read/write/search) over `~/.useful-bot/memory/*.md`, seeded from `~/.hermes/memories/` | `agent/tools/memory.ts` | Write then read back in a later session; nothing lands in git |
| 2.5 `web_search`: `web_fetch` plus our own search tool, since `web_search` only appears for supported providers | `agent/tools/web_search.ts` | Live query returns real results |
| 2.6 Subagents: `coder` (sandbox work), `researcher` (web), `reviewer` (pinned to `grok-4.6`) | `agent/subagents/*/agent.ts` | Each runs a real delegated task; each pinned model shows in the trace |
| 2.7 Sandbox: microsandbox backend, seeded workspace, network policy decision, approval gates on destructive tools | `agent/sandbox/sandbox.ts` | Write and run a file in `/workspace`; a destructive tool asks for approval |
| 2.8 One MCP connection (GitHub) | `agent/connections/github.ts` | A real read succeeds; a write requires approval |
| 2.9 One schedule proving cron works | `agent/schedules/weekly_digest.ts` | Fires on a manual trigger, produces a durable session |
| 2.10 CLI bridges: `gh`, `aside`, `remindctl`, `imsg` where useful | `agent/tools/*.ts` | Each bridge runs with an approval gate |

### Phase 3: the web UI

| Task | Files | Verify |
|---|---|---|
| 3.1 Scaffold `eve add channel/web` (Next.js chat) | `agent/channels/web/` | Chat page loads, one turn round-trips |
| 3.2 Design pass to `useful-design` standards: message stream, tool-call rendering, reasoning collapsed by default, session list, model picker | `agent/channels/web/**` | Visual check in the browser (Aside), screenshots in repo root |
| 3.3 Channel auth: `localDev()` locally plus a bearer for tailnet access; never leave the default placeholder | `agent/channels/eve.ts` | Unauthenticated request from another host is rejected |
| 3.4 Session resume and cancellation wired into the UI | `agent/channels/web/**` | Reload mid-turn resumes; cancel stops the durable turn |

### Phase 4: proof it works

| Task | Files | Verify |
|---|---|---|
| 4.1 Evals for the behaviours that matter (obeys the em-dash law, refuses to print secrets, uses memory, picks the right model for a task) | `evals/*` | `eve eval` green |
| 4.2 Two weeks of real use, on the machine, replacing Hermes for a defined task list | n/a | Wasim's own verdict |

### Phase 5: macOS app

| Task | Files | Verify |
|---|---|---|
| 5.1 Swift WKWebView shell around the Next.js UI, following the existing macOS shell skills | `macos/` | App launches, talks to the local agent, survives a sleep and wake |
| 5.2 Menu bar presence, global hotkey, notifications | `macos/` | Works |

### Out of scope for v1

Native mobile app (Expo client over the eve channel), a bulk skill-library converter, additional
flat-rate subscription adapters (Z.ai GLM, MiniMax, Qwen, Kimi Code, Tencent TokenHub, Chutes),
more MCP connections, multi-user anything. Documented in `docs/plan/` as the v2 backlog rather than
silently dropped.

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | eve is public beta; breaking changes between now and GA | Pin the version in `package.json`, read the changelog before upgrades, keep our code inside authored slots (tools, skills, channels) rather than framework internals |
| R2 | The ChatGPT-subscription bridge is the least sanctioned path | Drive the official CLI, keep it single-user and local, never share or expose the endpoint, revisit if OpenAI changes policy |
| R3 | Context-window numbers are unknown for registry models, and eve needs them | Explicit verification task (1.7); no guessed numbers |
| R4 | Tool-call and reasoning-content passthrough through a proxy is where these setups break | Interop tests per adapter (1.3 to 1.5), passthrough of `reasoning_content` verified explicitly |
| R5 | Local sandbox without Docker on macOS Apple Silicon | Spiked in S5 before anything depends on it; Docker stays an option if microsandbox disappoints |
| R6 | Quota noise: three subscriptions with different windows | Router reports the failing upstream loudly, plus a registry-level fallback chain |
| R7 | The four subscription plans drift (prices, model lists) | Registry is data, not code; a survey doc records what was true and when |

---

## 8. Open questions for the counsel

1. Is one router process the right boundary, or should each subscription be its own small service?
2. `codex app-server` versus per-turn `codex exec`: which survives real use better, and does either
   lose ChatGPT-subscription session semantics?
3. Where should cross-session memory live: plain markdown files, SQLite, or eve `defineState` plus a
   file store? What breaks at 10k memories?
4. Per-task model selection: is it cleaner to pin models per subagent, or to use step-level dynamic
   selection for one agent? Which one keeps prompt caches warm?
5. What is the smallest v1 that still replaces Hermes for a week of real work?
6. What did we get wrong in section 5?

---

## 9. Change log

- v0.1: first draft, grounded in eve docs read this session, machine recon, and the model catalogs
  dumped to `docs/research/`.
