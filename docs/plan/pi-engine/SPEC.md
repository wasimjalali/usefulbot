# Pi engine: replace eve, one strong bot

> **Owner, 2026-10-25 13:42: the Pi release ships as a brand-new app.** The owner is the only user, so there is
> no migration and no compatibility code for older installs: no `shell.json` v1 migration, no archived or
> earlier bots, no moved routines, no first-launch note, no OpenAPI note, no image-prompt backfill, no eve
> leftovers kept for a release (PR 4 is folded into PR 3). A store whose format changed starts fresh; stores
> whose format didn't (providers, config, Keychain, memory, routines, connections, media) keep working with no
> extra code. Where this file says otherwise, this note wins.

Status: draft 3, 2026-10-25 (one bot only, chat-first UI). Draft 2 was hardened by a five-model
council (Fable 5.1, Sonnet 5.5, Haiku 5.5, GLM 5.3, DeepSeek V4.1 Flash; record in
`evals/results/2026-10-24-pi-engine-spec-council.md`). Author: Opus 5.5 orchestrator.
UI, UX and the UI-to-backend contract: `UI.md` (mockups pending owner approval in Claude Design).
Plan, PR briefs and the file ownership table: `PLAN.md`. Ground truth of today's code (file:line
on `main` @ 9dc43a0f): `app-map/agent.md`, `app-map/web-shared.md`, `app-map/swift.md`,
`app-map/router-ops-tests.md`. Read the matching map before touching a file this spec names.

## 0. What this changes

1. The agent runtime moves from Vercel's eve (0.54.3, pinned, 57 releases behind) to the Pi agent
   harness SDK (`@earendil-works/pi-coding-agent`, exact pin), hosted in our own Node process.
2. The app gets one engine-neutral chat protocol of our own. The engine serves chat history as
   ready rows; the Swift app stops replaying and folding eve's event journal.
3. The product goes from a team of specialist bots to **one** strong all-round bot (owner's
   decision, 2026-10-25), and the sidebar lists chats instead of bots (`UI.md`). Groups,
   sections, handoffs, fan-out, sub-agents and bot creation are removed.
4. Everything that already works without eve stays: the router, the approval store, command risk,
   the seatbelt sandbox, memory, routines, Composio, our MCP client, media, auth.
5. **Clean slate for chats** (owner's decision, 2026-10-24): old eve chats are not migrated. The
   update deletes eve's store. Memory notes, routines, connections, providers, the media library
   and settings carry over.

## 1. Why

- eve is a preview "for durable backend agents on Vercel". Every turn is a checkpointed workflow
  on a beta Workflow SDK. That replay design causes the worst failures on a single-user Mac: one
  failed turn retires the session (`409 session_not_active`), a replayed step that renders other
  bytes retires it too (`agent/memory/notes.ts:22-35`), sessions can be stranded on an eve upgrade,
  and open upstream issue #2876 wedges runs past about 6k events (our perf fixture has 14,407).
- Real eve bugs hit us and were fixed upstream only later: orphaned tool call after a length stop
  (0.70.2), compaction sending `temperature:0` (0.66.0), compaction retries (0.75.1), the chunk scan
  behind 5-second chat opens (0.83.2), a bundler scope bug.
- About 7,000 lines exist only to adapt eve (2,600 Node, 4,400 Swift), 103 commits touch them, and
  `scripts/patch-eve.mjs` edits eve's internals and blocks every upgrade.
- Disk: the daily app holds about 1.5 GB of eve workflow files.
- Staying is not free: 0.54.3 to 0.83.2 removes background tasks, `todo`, `load_skill`,
  microsandbox and the session-limit API we use.

Why Pi: MIT, embeds in-process, append-only JSONL session tree, compaction with overflow and length
recovery, provider retries that honour `retry-after`, a fail-closed `tool_call` gate, and an
OpenAI-compatible client that accepts a custom `fetch`. OpenClaw, a personal assistant, is built on
it. The alternatives were weighed on 2026-10-24: the Claude Agent SDK is Claude-only and
proprietary, the Codex SDK speaks only the Responses API, opencode is a coding CLI with heavy
churn, Mastra and LangGraph are whole frameworks, and the AI SDK alone would mean rebuilding what
Pi already hardened.

## 2. Design principles

From Anthropic's guidance ("When to fold subagents into your main agent loop", 2026-10-22;
"Harness design: 3 patterns"; "Scaling Managed Agents with stable interfaces"; "Effective context
engineering") and our incidents:

- **One loop, one context window.** A single agent with skills and on-demand tools. No sub-agents.
- **Tools grouped by user intent, 30 or fewer declared.** Hard limits and approvals live inside
  tools.
- **Progressive disclosure.** Skills load on demand; MCP tools are found with `find_tools`.
- **The session file is the durable truth; the engine is replaceable.** Nothing essential lives
  only in engine memory, except what the spec names as lost on a crash (5.5.10).
- **Prompt-cache friendly.** Static content first, per-turn updates as a message at the end; tools
  and model never change inside a turn.
- **Typed tools for gated actions.** Bash stays general, gated by the command-risk classifier.
- **Secrets never reach model-controlled processes.**
- **Fail loud.** A failure is a visible row with a reason and, where it makes sense, Retry.

## 3. Target architecture

```
macOS app (Swift)
   |  loopback HTTP, cookie session + CSRF (unchanged)
   v
web service (Next, API only)              router (unchanged role)
   |  /api/chats/* proxied, NDJSON passthrough   ^  OpenAI-compatible chat, images, search
   |  internal bearer                            |  x-useful-* headers, selection frozen per turn
   v                                             |
engine service (plain Node, NEW) ----------------+
   Pi SDK sessions (one per open chat), our tools, approvals store,
   rows + live event bus, routine scheduler, system turns
   state: <stateRoot>/engine/
```

Three processes stay three (router, engine, web). The engine takes eve's port numbers (4321 daily,
4421 dev). The router stays the only egress to model providers.

## 4. Decisions

The implementing agents follow these defaults. The owner can override any of them.

| # | Decision | Default |
|---|---|---|
| D1 | Engine | Pi SDK, exact pin (1.4.0 at writing), in `agent/server.ts`, all Pi calls behind `agent/engine/pi-host.ts` |
| D2 | Where Pi runs | Separate plain Node process. Not inside Next (dev duplicates route modules and hot-reloads) |
| D3 | Model path | Through the router. A registered native provider delegates to Pi's built-in `openai-completions` stream with our `routerFetch` |
| D4 | Pi built-ins | All off: no built-in tools, no extensions from disk, no skill or context-file discovery, in-memory settings, nothing read under `~/.pi` |
| D5 | Bots | One bot: the default (`bot-useful`), named "Useful Bot" (PR 2b renames the stored bot; the name can't be edited). No second bot, no bot switcher, no bot creation |
| D6 | Other existing bots | None: the release is a fresh install (owner, 2026-10-25). PR 2's archive and Earlier bots are removed in PR 3 |
| D7 | Sub-agents | Removed |
| D8 | Groups, sections, pins, hide, handoffs, fan-out, cross-bot send, bot and group proposals, profile proposals | Removed |
| D9 | Chats | The sidebar is the chat list (one Pi session per chat): new, open, rename, delete (to a trash kept 30 days), search, live state per chat (`UI.md` 3.3) |
| D10 | Transcript | Rows built by the engine from the session file. Overlay rows (images, pages, widgets, notes, cards, failures) are `custom` entries in the same file |
| D11 | Live updates | Per-chat NDJSON event stream with host-owned `seq` and engine `epoch`, ring buffer, heartbeat |
| D12 | Approvals | Keep `approvals.json`, hash binding, routes, 1.5 s poll; waits race the abort signal; stale cards expire at boot |
| D13 | Questions | `ask` tool, called alone, ends the turn; the answer is the owner's next message |
| D14 | Sends during a running turn | Queued **in the host** and sent as their own turn after the running one settles. Pi's follow-up queue is not used |
| D15 | Mid-turn crash | No resume. The turn is closed with an "Interrupted" row and Retry |
| D16 | MCP | Our own client, OAuth, Keychain auth, `find_tools` and `<connectionId>__<tool>` names; picked tools registered as Pi tools |
| D17 | OpenAPI connections | Dropped, with no note for old entries |
| D18 | Routines | Scheduler in the engine (20 s timer), at most 4 at once. Each routine runs in its own chat (created on first run, reused), so runs never pile into the owner's chat |
| D19 | Connect-card resume | Web calls the engine's system-turn endpoint (PR 3, which also deletes the handoff queue); PR 2 keeps the handoff queue for this one use |
| D20 | Tools dropped | `list_bots`, `rail_action`, `delete_bot`, `propose_bot`, `propose_group`, `post_to_group`, `send_to_bot`, `update_bot_profile`, `clear_history`, `review`, `list_models`, `plant_read`, eve `agent`, `task_cancel` |
| D21 | Tools merged | memory (4 to 1), routines (5 to 1), Composio apps (4 to 1) |
| D22 | Old chats | Clean slate. Not imported, not archived |
| D23 | eve's store | Deleted by the Pi release: the runtime rsync stops excluding `/.eve/`. No first-launch note |
| D24 | Reasoning effort | Pi thinking level `off`; the router applies effort from the selection |
| D25 | Reviewer role | Removed: `review` tool, `/api/reviewer`, the Providers pane reviewer row. The router alias stays unused |
| D26 | Delivery | PR 1 (router), PR 2 (one bot) and PR 2b (chat-first UI) land on `main` on eve; PR 3 is the engine swap on a feature branch; PR 4 cleans up. See `PLAN.md` |

## 5. Engine service

### 5.1 Process, port, auth, health

- Entry `agent/server.ts`, run by `scripts/service.mjs engine` as
  `node --experimental-strip-types agent/server.ts`, bound to `127.0.0.1:<enginePort>`.
- `service.mjs` builds the engine's env explicitly (never `...process.env`): `PATH`, `HOME`,
  `TMPDIR`, `LANG`, `TZ`, `UB_STACK`, `UB_STATE_ROOT`, `UB_*_PORT`, `UB_KEYCHAIN_PREFIX`,
  `UB_MEDIA_DIR`, `UB_ENGINE_TOKEN` (Keychain `channel.desktop`), `UB_ROUTER_DESKTOP_TOKEN`
  (Keychain `router.desktop`), `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`,
  `PI_CODING_AGENT_DIR=<stateRoot>/engine/pi` (backstop: Pi falls back to `~/.pi/agent` when a path
  is not supplied). No reviewer token.
- Auth: `Authorization: Bearer <UB_ENGINE_TOKEN>` on every route except `GET /health`. Host must be
  `127.0.0.1[:port]`; any `Origin` header is refused.
- `GET /health` returns `{ok, stack, epoch, pi: "<version>"}`.
- Boot order: kill any eve listener left on the engine port by an older install of the same stack
  (match `node_modules/eve/` in its command line), expire stale approvals (5.9), close interrupted
  turns (5.5.10), start the routine timer, then listen. Boot never throws on one bad chat: a chat
  file that fails to load gets an `unreadable` failure row and the engine continues.
- SIGTERM: abort running turns, flush, exit within 10 s.
- Every new path derives from `stateRoot()` (no new `UB_*_PATH` env vars, so `test/dev-stack.test.ts`
  stays valid): `<stateRoot>/engine/sessions/<botId>/`, `<stateRoot>/engine/pi/`,
  `<stateRoot>/engine/running.json`, `<stateRoot>/engine/chats.json`.

### 5.2 Pi embedding

`agent/engine/pi-host.ts` owns one `EngineHost`:

- `modelRuntime = await ModelRuntime.create({ authPath, modelsPath })`, both under
  `<stateRoot>/engine/pi/` and empty (no credentials are stored; see 5.3 auth).
- `settingsManager = SettingsManager.inMemory({ compaction: {...5.7}, retry: { enabled: true,
  maxRetries: 2, provider: { maxRetries: 0 } }, cacheWarming: "off", enableInstallTelemetry:
  false, defaultTools: [] })`. Provider-level retries stay 0 because `routerFetch` waits out 429s
  itself and the router refuses a repeated request id.
- A custom `ResourceLoader` implementing the whole interface (`getExtensions`, `getSkills`,
  `getPrompts`, `getThemes`, `getAgentsFiles`, `getSystemPrompt`, `getSystemPromptSource`,
  `getAppendSystemPrompt`, `getAppendSystemPromptSources`, `extendResources`, `reload`), modelled on
  `examples/sdk/12-full-control.ts`. `getExtensions` returns our single engine extension built with
  `loadExtensionFromFactory`. Skills, prompts, themes and agents files are empty (skills reach the
  model through our `load_skill` tool and the skills list in the system prompt).
- Sessions: `createAgentSession({ cwd: <stateRoot>/engine, agentDir: <stateRoot>/engine/pi, model,
  thinkingLevel: "off", modelRuntime, resourceLoader, noTools: "builtin", customTools,
  sessionManager, settingsManager })`. **Never pass `tools`**: an allowlist (even an empty one)
  filters out our custom tools and every later `registerTool`.
- `sessionManager`: new chat `SessionManager.create(cwd, <sessions>/<botId>, { id: chatId })`;
  existing chat `SessionManager.open(sessionFile)`. Pi names the file
  `<timestamp>_<chatId>.jsonl` and writes it only after the first message, so the chat index
  (5.4) stores `sessionFile` once it exists.
- Pool: at most 4 idle `AgentSession`s; idle ones (no turn for 15 min and not open in the app) are
  disposed and reopened from file on next use. A session with a running turn is never evicted, so
  the pool can exceed 4 while turns run.
- Concurrency: one turn per chat; different chats run at the same time.
- Contract test: after `createAgentSession`, the declared tool list equals our tool names exactly
  and contains none of Pi's built-ins; a full turn opens no path under `~/.pi`.

### 5.3 Model path through the router

- The engine extension calls `pi.registerProvider()` with a native `Provider` `useful-router`:
  - `auth`: an in-memory static API-key `ProviderAuth` resolving `UB_ROUTER_DESKTOP_TOKEN` from
    the process env, so `prompt()` and `setModel()` see configured auth. Nothing is written to
    `auth.json`.
  - `api: "openai-completions"`, `baseUrl: http://127.0.0.1:<routerPort>/v1` (never `localhost`:
    the router refuses it).
  - Models: registered lazily, one per selection actually used by a bot, id
    `"<connectionId>/<modelId>"`, with `contextWindow` (catalog `contextTokens`, else 32,768),
    `maxTokens` (the router's output cap for that model), `input` (`image` only when the catalog
    says vision), `reasoning: false`, zero cost (the router meters spend). Re-published through
    `refreshModels` / `context.publish` when the providers store changes.
  - `compat`: `supportsStore: false`, `supportsDeveloperRole: false`,
    `supportsReasoningEffort: false`, `maxTokensField: "max_tokens"`,
    `supportsUsageInStreaming: true`, `supportsLongCacheRetention: false`,
    `sendSessionAffinityHeaders: false`, `supportsStrictMode: false`,
    `supportsOpenAIGrammarTools: false`, `supportsMidConvoSystemMessages: false`.
  - `streamSimple` delegates to Pi's built-in `openai-completions` implementation with
    `fetch: routerFetch(ids, selection)` and `onPayload` setting `model: "workhorse"` (the router
    resolves the selection header only for that alias).
- `routerFetch` (`agent/lib/router-fetch.ts`) keeps its contract: on every HTTP attempt it stamps
  `x-useful-session-id` (stable UUID from `chatId`), `x-useful-turn-id` (the turn's id), a fresh
  `x-useful-request-id`, and `x-useful-selection` (base64url `{connectionId, modelId, effort,
  speed}`), and waits out router 429s. It records the last router error
  `{status, code, retryAfterMs, resetsAt, message}` per turn in a side table that `turn.failed`
  reads; Pi's `errorMessage` text is never parsed for codes.
- Selection is frozen per turn: resolved once at turn start (`botSelection(bot, store)`, today's
  rule); `session.setModel()` is called only between turns; a pick made during a turn applies to
  the next one. Note: switching models breaks the prompt cache, which is accepted (owner feature).
- Effort and speed ride in the selection header; Pi's thinking level stays `off`.
- `web_search` and `generate_image` keep calling the router directly with the same ids.
- Compaction summaries go through the same provider with the chat's frozen selection, so they
  share the chat's router session id. Contract test: a summary call never collides with the
  router's per-session `session_busy` gate.

### 5.4 Chats

- A chat is one Pi session file under `<stateRoot>/engine/sessions/<botId>/`.
- The engine owns the chat index `<stateRoot>/engine/chats.json`:
  `{schemaVersion: 1, chats: [{chatId, botId, sessionFile|null, title, titleSetByOwner, preview,
  routineId|null, fixture, createdAt, updatedAt}]}` (atomic write, single writer). Title = first
  owner message (60 chars) until the owner renames it; a routine chat's title is the routine's
  name; preview = last assistant text (120 chars); `updatedAt` changes when a turn starts or a row
  is added; `fixture` marks the dev-stack perf chats (14), which `GET /api/chats` leaves out unless
  `includeFixtures=1` (the perf harness).
- `shell.json` keeps per bot only `chatId` (the current chat) and drops `sessionId`, `recents`,
  `previousSessionIds`, `continuedSessionId`, lineage and carry-over fields. The engine writes the
  bot's `chatId`, `lastPreview` and `lastAt` under the shell lock when a turn settles.
- `shell.json` moves to `schemaVersion: 2` in PR 3 with a one-way migration (clean slate: every
  `chatId` starts null). The v1 file is kept as `shell.json.v1.bak`. Downgrading the app is not
  supported.
- New chat: `POST /api/chats {botId}` mints a `chatId` (UUID v4) and makes it current; the file
  appears with the first message.
- List: `GET /api/chats?botId=&before=&limit=60` pages the bot's chats from the index, newest
  `updatedAt` first, no cap on the total.
- Rename: `PATCH /api/chats/:id {title}` (1 to 60 chars, sets `titleSetByOwner`).
- Delete: `DELETE /api/chats/:id` refuses while a turn runs (`chat_busy`), else moves the session
  file to `<stateRoot>/engine/trash/` with a `deletedAt` stamp, removes the chat from the index
  and expires its approval cards. If it was the bot's current chat, the engine makes the newest
  remaining chat current (or none) and the response carries `{current}`. The engine purges trash
  older than 30 days at boot; the app offers no restore. Deleting a routine's chat clears
  `routine.chatId` (the next run creates a new chat); deleting a routine clears `routineId` on its
  chat. Library items the chat produced stay.
- Search: `GET /api/chats/search?q=&limit=50` matches titles and previews from the index, then
  scans row text of chats newest first (case-insensitive substring, stops at `limit` hits or
  2 s), returning `{chatId, rowId, title, snippet, at}`.

### 5.5 Turns

A **turn** is one prompt (owner message, routine or system) and all model and tool work until Pi
settles. Because the host never uses Pi's follow-up queue, one `session.prompt()` is exactly one
turn and `agent_settled` ends it. The host mints `turnId` (UUID v4).

1. **Admit.** Refuse before Pi sees anything, with a typed 400/409 (6.4):
   `model_selection_unavailable`, `provider_route_retired`, `model_no_vision`,
   `description_too_long` (bot instructions over 8,000 chars, `DESCRIPTION_MAX` in
   `shared/shell-store.ts:37`), `context_too_large` (the **envelope**: system prompt + per-turn
   context + active tool schemas + 4,096 output tokens, measured from `session.systemPrompt` and
   the registered tool definitions, exceeds the window), `retry_too_soon {retryAfterMs}`.
   Duplicate `clientId` for the same chat returns the original `{turnId}` (idempotent).
2. **Queue.** If the chat has a running turn, the message is appended to the host queue, persisted
   as a `ub.queued {clientId, text, attachments}` custom entry, and the app gets `message.queued`.
   Queued messages start in order, each as its own turn, when the previous turn settles. Owner
   messages that queue behind a failed turn still run. On cancel, every queued message is dropped:
   a `ub.queued-drop` entry, a `message.dropped {clientId}` event, and the app shows it as an
   unsent bubble with Send again. At boot, leftover `ub.queued` entries become unsent rows the same
   way.
3. **Stamp.** Write `running.json` (`{chatId, turnId, startedAt}` per running turn), write the
   workspace grant `{chatId, path, permission, selection}` (tools read it, as today), freeze the
   selection, write a `ub.turn-start {turnId, origin, clientId}` entry.
4. **Start.** `session.prompt(text, { images, expandPromptTemplates: false })` (owner text that
   starts with `/` must never trigger Pi's command, skill or template expansion). Text attachments are inlined into the prompt text
   inside an untrusted fence titled with the file name (`shared/untrusted.ts`); a
   `ub.attachments {turnId, items: [{name, mediaType, size}]}` entry records them for the row. If
   `prompt()` rejects before the run starts, write `ub.turn-end {outcome: "refused"}` and a failure
   row.
5. **Stream.** Pi events map to protocol events (6.3).
6. **Settle.** On `agent_settled`: `turn.completed`, or `turn.cancelled` if aborted, or
   `turn.failed` when the last assistant message stopped with an error. Write
   `ub.turn-end {turnId, outcome}`, clear the turn from `running.json`, update the chat index and
   `shell.json` preview, then start the next queued message if any. If an `ask` question is open at
   settle, the bot is `waitingOnOwner`.
7. **Cancel.** `POST /api/chats/:id/cancel` returns 202 at once. The engine first expires the
   chat's pending approval cards (`ApprovalStore.expireSession`), then calls `session.abort()`.
   Approval waits race the tool's abort signal, so a pending card never holds the cancel. The
   `turn.cancelled` event comes on settle.
8. **Failure.** The session is never retired. `turn.failed` carries `{code, detail, retryAfterMs,
   resetsAt, messageKept: true}` from the router side table, else `{code: "engine_error"}` with
   Pi's message. A `ub.failure` entry makes the row survive reloads.
9. **Retry.** Only for the chat's newest failed turn, only when idle, only after `retryAfterMs`.
   The engine calls `session.navigateTree(failedUserEntryId, { summarize: false })` (it moves the
   leaf to the parent of that user message, refreshes Pi's in-memory context and returns its text),
   then prompts that text with the original `clientId` and `retry: true`. The failed attempt stays
   in raw history on an abandoned branch. `turn.started {retry: true}` tells the app to drop the
   newest failure row and keep the original owner bubble.
10. **Interrupted.** At boot, every turn still in `running.json` gets a `ub.failure {code:
    "interrupted"}` and `ub.turn-end {outcome: "interrupted"}`; Retry works as in step 9. A turn is
    otherwise never resumed. What is lost on a crash: the in-progress assistant text and any queued
    message not yet persisted (none, since step 2 persists first).

### 5.6 Prompt and context

- **System prompt (static, cached):** `agent/instructions.md` rewritten for one all-round bot
  (under 950 words; `test/prompt-texts.test.ts` keeps the cap and its tool-name list becomes ours),
  then the skills list (name and one-line description of each skill in `agent/skills/`), then the
  bot block: `You are Useful Bot.` plus the owner's instructions fenced as today
  (`shared/context-blocks.ts` "Your bot"). It changes only when the owner edits the bot. Remove
  "Running the team", the group block, "another bot is a peer", sub-agent, handoff and reviewer
  text. Add `GENERALIST_SEED_V3` to `shared/shell-store.ts` (seeds are append-only) without team
  language.
- **Per-turn context (dynamic, last):** "This turn" (owner name, date at day granularity and time
  zone, permission label, folder or "no folder", chat model, image model, first-chat flag) and the
  notes block (`shared/notes-block.ts`, unchanged). Delivered from `before_agent_start` (it fires
  once per turn, since one prompt is one turn) as a hidden custom message (`display: false`,
  customType `ub.context`), only when its text differs from the last one sent in this chat's
  active branch, and always on the first turn after a compaction. A compaction in the middle of a
  turn does not re-send it; the next turn does.
- Untrusted content keeps the existing fences and the per-turn outside-content taint
  (`agent/lib/outside-content.ts`, root and child marks removed).
- The notes replay-digest store (`memory/recall/`, `agent/memory/notes.ts:22-35,64-104,146-181`)
  is deleted; the renderer moves into `shared/notes-block.ts` (W2), which `agent/engine/context.ts`
  (W1) calls.

### 5.7 Compaction

- Pi's automatic compaction with `compaction: { enabled: true, reserveTokens, keepRecentTokens,
  modelOverrides }`. For each registered model, `modelOverrides["useful-router/<connectionId>/
  <modelId>"]` (Pi's `${provider}/${model.id}` key) is `{ reserveTokens: max(4096,
  floor(0.25 * window)), keepRecentTokens: min(20000, floor(0.25 * window)) }`. The top-level
  values use the 32,768 default window (8,192 and 8,192). That reproduces today's "compact at 75%".
- Overflow or early length stop: Pi's single compact-and-retry recovery stays on.
- `session_before_compact` only logs (replaces `agent/hooks/compaction-log.ts`).
- `compaction_start` maps to `activity compacting`; `compaction_end` to `compaction.done`. The
  compaction entry itself renders as a quiet note row (5.12).

### 5.8 Tools

**Contract first.** The orchestrator writes `agent/lib/tool.ts` (types and a working shim) and the
context contract below in the first commit of PR 3, before workers start.

```ts
type ToolCtx = {
  chatId: string; botId: string; turnId: string; callId: string;
  origin: "owner" | "routine" | "system";
  abortSignal: AbortSignal;
  snapshot: TurnSnapshot;               // bot, selection, window, permission, folder, context
  session: { id: string; turn: { id: string } };   // compat: id = chatId
  appendRow(row: RowInput): Promise<void>;          // ub.row entry + `row` event, idempotent by row.key
};
defineTool({ name, label?, description, inputSchema, execute, sequential?, prepareArguments? })
```

- The returned object keeps `.inputSchema` (tests import it) and exposes a Pi `ToolDefinition`.
- `parameters` is the zod schema converted with `z.toJSONSchema(schema, { io: "input" })` (plain
  JSON Schema; Pi validates it before `execute`, applying `normalizeOptionalNulls` and JSON-Schema
  coercion). The `lenient-null` coercions move into `prepareArguments`, which Pi runs before
  validation. `execute` then parses with zod. Contract test: every tool's schema compiles with Pi's
  validator and accepts the lenient inputs of `test/lenient-tool-input.test.ts`.
- `executionMode: "sequential"` for every gated or stateful tool: `bash`, `write_file`, `memory`,
  `routine`, `apps`, `connect_server`, `find_tools`, every picked MCP tool, `generate_image`,
  `install_cli`, `todo`, `ask`. Read-only tools (`read_file`, `list_dir`, `web_search`,
  `web_fetch`, `load_skill`) keep the default, so a batch of only read-only calls runs in
  parallel; Pi runs the whole batch sequentially as soon as one call in it is sequential.
- Helper replacements in tool code: `authoritySessionId(ctx)` becomes `ctx.chatId`; `callerOf(ctx)`
  becomes `ctx.botId`; `isSubAgent` and every sub-agent branch go; `markOutside(ctx)` and
  `toolRouterIds(ctx)` keep working on the new ctx; `ensureTurnSnapshot(ctx, turnId)` becomes
  `ctx.snapshot`; `approvalActor(ctx)` returns `{chatId, turnId, callId, botId}`.

**Declared tools (16):**

| Tool | From | Notes |
|---|---|---|
| `bash` | `bash.ts` | seatbelt profiles, command risk, approval cards unchanged |
| `read_file`, `write_file`, `list_dir` | as today | path guards, 16 KB read cap, atomic gated writes, `.html` pages |
| `web_search` | as today | result `details.searchResults` drives chips |
| `web_fetch` | rewritten | see below |
| `memory` | 4 merged | `action: search | read | save | delete`, same store and caps |
| `routine` | 5 merged | `action: list | create | update | delete | run` |
| `apps` | `connector_catalog`, `connector_search`, `connector_execute`, `propose_connector` | `action: find | tools | run | connect`; `connect` takes `{toolkit}` and writes the connect-app card as today |
| `connect_server` | `propose_connection` | `{url, name?, description?}`, MCP only (D17) |
| `find_tools` | `connection_tools.ts` | picks MCP tools for this chat |
| `generate_image` | as today | stores the prompt in the media index (5.10) |
| `install_cli` | as today | |
| `todo` | rewritten | state in tool-result `details` (Pi's branch-aware pattern) |
| `ask` | new | `{prompt, options?: [{id,label,detail?}], allowFreeform?}` |
| `load_skill` | new | `{name}` returns the skill's full text |

Picked MCP tools add at most 40 (`MAX_SESSION_TOOLS`). They register with `pi.registerTool`
(`defaultActive: false`) at first pick and activate through `pi.setActiveTools` between model
requests. Picks are stored per chat in `connection-tools.json` keyed by `chatId`.

**`ask`.** Pi's `tool_call` event carries only the one call, so the gate reads the batch from the
last assistant message on `ctx.sessionManager.getBranch()` (Pi persists it at `message_end`,
before any tool runs). On the batch's first `tool_call`, if the batch contains `ask` and any other
call, every call in it is blocked ("ask must be the only call; ask again after the other work").
So `ask` always runs alone and `terminate: true` always ends the turn. `ask` writes a `ub.question` entry and emits `input.requested`. If a turn
settles with a question open, it stays open until the owner's next message, which emits
`input.resolved` before its `turn.started`.

**`web_fetch`.** Ours, replacing eve's: http(s) only; DNS-resolved public addresses only
(`assertResolvedPublic` from `shared/connection-url.ts`), re-checked on every redirect hop
(`redirect: "manual"`, at most 5 hops); no userinfo; 5 MB streamed download cap; HTML converted to
Markdown with `turndown` (exact pin, new dependency); 50 KB model-facing output cap (today's,
`agent/tools/web_fetch.ts:13`); untrusted fence. Tests: IPv4 and IPv6 private, loopback,
link-local and metadata ranges, userinfo, odd ports, redirect to loopback, DNS rebinding between
lookup and connect (connect to the resolved address).

The `tool_call` gate also refuses any tool name not in the registered set (fail closed).

### 5.9 Approvals and questions

- Tools keep raising cards in `approvals.json` and waiting in-process. `waitUntilNotPending` gains
  an `AbortSignal` parameter and returns `aborted` when the turn is cancelled.
- Card records carry `chatId` and `botId`; `GET /api/approvals` returns them (no `botName`; there
  is one bot). The app labels a card whose `chatId` is not the open chat ("From another chat", with Open chat).
  `rootSessionId`, `subagent` and `originLabel` go.
- At boot the engine calls `invalidateOnRestart` (no production caller today), so no ghost cards.
- Cancel expires the chat's cards before aborting (5.5.7).
- Questions: 5.8 `ask`. Session-limit prompts disappear (no per-session cap; the router's daily
  budgets guard spend).

### 5.10 Connections, Composio, widgets, media

- Composio stores and client unchanged; tools merged into `apps`.
- MCP store, OAuth, Keychain auth, `callMcpTool`, `mcpToolGate`, 24 KB result cap and auth-failure
  marks unchanged. `find_tools` index and scoring unchanged; picks keyed by `chatId`.
- Tool-budget guards stay (`MAX_TOOL_SCHEMAS`, `MOUNTED_TOOL_BUDGET`, tool byte weighing): the
  router still refuses oversize tool arrays. `MAX_MESSAGE_COUNT` stays as a router limit.
- **Widgets:** detection keeps the `<connectionId>__<tool>` name plus `ui://` meta
  (`shared/mcp-apps.ts`, adapted from eve's action event to the tool-call shape). The engine emits
  `tool.call {callId, widget: {connectionId, toolName, arguments}}`. The app persists through
  `POST /api/agent/widget {botId, chatId, callId, data}`; the web stores it (the widget record
  gains `chatId`) and appends a widget row through the engine with key `widget:<callId>`. The
  client replaces its live widget `live-<callId>` with that row. The orphan sweep keeps a widget
  whose chat's session file exists or that the Library holds.
- **Images:** `generate_image` writes the prompt into the media index entry (`media.json` gains
  `prompt`). `web/lib/image-regenerate.ts` reads it from there instead of `agents.json` threads.
  PR 3 backfills `prompt` for existing library images from `agents.json` threads before threads
  are dropped.
- **Pages:** `write_file` with `.html` appends a page row (`appendRow`) and files the Library item
  as today.
- Eager OpenAPI mounting is deleted (D17); the Connectors list marks old OpenAPI entries.

### 5.11 Routines and system turns

- Engine timer every 20 s (today the cadence comes from the app's poll; behaviour while the app
  runs is the same): `pendingRoutines(now)`, at most 4 running, one per routine, claimed with
  `claimDueRoutine` / `claimManualRun`.
- A routine runs in **its own chat** (`routine.chatId`, created on the first run with the
  routine's name as title and `routineId` in the index, reused afterwards) with
  `origin: routine`, queued behind a running turn in that chat (no timeout, as today). A `ub.context` message
  says "Scheduled run of the routine NAME. Nobody is watching: do not ask questions or wait for
  cards." A note row "Routine NAME ran." precedes it. Budget: 1 hour per run, 10 minutes without
  events aborts it. The result is recorded with `appendRoutineRun`.
- Manual run: `POST /api/routines/:id/run` (web) calls `POST /internal/routines/:id/run` (engine),
  which claims and runs it.
- System turns (`POST /internal/bots/:botId/system-turn`) carry connect-card resume (D19) with
  `origin: system`.
- The app keeps calling `POST /api/agent/tick` every 2.5 s; the tick keeps only the connect pumps
  (`pumpConnects`, `pumpConnections`, `seedDefaultConnections`) and the orphan sweep.

### 5.12 Rows

The engine builds rows from `sessionManager.getBranch()` (the full path from root to the active
leaf, all entries). **Never from the compaction-aware context projection**, which would drop
summarized history from the transcript.

| Row kind | Source |
|---|---|
| `user` | message entry, role user; attachments from the turn's `ub.attachments` |
| `assistant` | message entry, role assistant, with text (thinking hidden); a text-less assistant message (tool calls only) makes no row |
| `note` | `ub.row {kind: note}` (routine ran, connected) and every `compaction` entry ("Conversation compacted to fit the model's window") |
| `failure` | `ub.failure {turnId, code, detail, retryAfterMs, resetsAt}` |
| `question` | `ub.question` (open until the next user message) |
| `unsent` | `ub.queued-drop` and leftover `ub.queued` at boot |
| `image`, `page`, `widget` | `ub.row` with ids into the media and widget stores (`widget` also `callId`) |
| `card` | `ub.row {kind: card, proposalId}` (connect app or server) |

- **Row ids are deterministic** so live and fetched rows match: user row `<turnId>:u`; assistant
  rows `<turnId>:a<n>` where n counts text-bearing assistant messages in the turn from 0; `ub.row`
  rows use their `key`; failure `<turnId>:f`; question `<turnId>:q`. Turn boundaries come from
  `ub.turn-start` / `ub.turn-end` entries. Live, the host mints the user id at the user
  `message_start` and an assistant id at that message's first `text_delta` (a message with no text
  never gets one), so live and rebuilt ids agree. Each text-bearing assistant message is its own
  row; consecutive ones in a turn are not merged.
- The engine caches rows per open chat, built once from the file and appended to as entries
  arrive. Building rows for a 15k-entry chat must take under 150 ms (contract test 12).
- `GET /api/chats/:id/rows?before=<rowId>&limit=60` pages backwards. The newest page carries
  `{rows, tailSeq, epoch, running: {turnId, partialText, activity} | null, queued: [...],
  openQuestion | null}`.

## 6. Chat protocol v1

All paths are on the web service under `/api` with cookie session and CSRF as today; the web
proxies them to the engine with the engine token and streams NDJSON without buffering. On the
engine the same routes drop the `/api` prefix (`/chats/...`), and `/api/engine/status` is the
engine's `/status`.

### 6.1 Requests

| Method + path | Body | Result |
|---|---|---|
| `GET /api/chats?botId=&before=&limit=` | | `{current: chatId|null, chats: [{chatId, title, preview, routineId, updatedAt}], nextBefore}` |
| `POST /api/chats` | `{botId}` | `{chatId}` (new chat, becomes current) |
| `PATCH /api/chats/:chatId` | `{title}` | 200 |
| `DELETE /api/chats/:chatId` | | 200, or 409 `chat_busy` |
| `GET /api/chats/search?q=&limit=` | | `{hits: [{chatId, rowId, title, snippet, at}]}` |
| `POST /api/chats/:chatId/open` | | marks it current and open in the app (clears `replyReady`) |
| `GET /api/chats/:chatId/rows?before=&limit=` | | page (5.12) |
| `GET /api/chats/:chatId/events?after=<seq>&epoch=<epoch>` | | NDJSON, stays open |
| `POST /api/chats/:chatId/turns` | `{clientId, text, attachments: [{name, mediaType, size, text?, dataUrl?}], retry?: true}` (up to 5; `text` or `dataUrl` as `POST /api/attachments` returned them; there is no upload store) | 202 `{turnId}` or `{queued: true}`; refusals 6.4 |
| `POST /api/chats/:chatId/cancel` | | 202 |
| `GET /api/engine/status` | | `{epoch, cleanSlateNotice, chats: [{chatId, running: {turnId, activity}|null, waitingOnOwner: "question"|"approval"|null, replyReadySince|null, lastTurn: {turnId, outcome, endedAt}|null}]}`: every chat that is working, waiting on the owner, reply-ready or whose newest turn failed (until a later turn starts), plus chats with a `lastTurn` in the last 24 h |
| `GET /api/proposals?botId=` | | open connect-app and connect-server proposals with their phase (replaces the proposals half of `/api/agent/state`) |

- `clientId` is a client UUID echoed on `message.user`, so the optimistic bubble binds by id.
- The app polls `/api/engine/status` with the approvals poll (1.5 s) and drives the chat-row state
  marks (`UI.md` 3.3), turn notifications (on a `lastTurn` change while the window is not key or
  the chat is not open, if the bot's notify setting is on) and
  the Dock badge from it. `cleanSlateNotice` is true from the clean-slate migration until the first owner turn starts (persisted in `migration.json`). `replyReadySince` is set when a turn settles in a chat that is not open in the app
  and cleared by `POST /open`.
- The app polls `/api/proposals` while a card is in the waiting phase (2.5 s), as it polls
  `/api/agent/state` today. Proposal confirm and dismiss stay on `PUT /api/shell`.

### 6.2 Events

Envelope `{seq, epoch, at, chatId, turnId?, type, ...}`. The **host** owns `seq` per chat per epoch
(it survives session eviction) and keeps the last 2,000 events per chat in a ring buffer.

- Connect order (client): open the event stream first, then fetch rows, then apply only events
  with `seq > tailSeq`.
- On connect the engine sends `stream.ready {tailSeq, resync}`. `resync: true` (the `after` value
  is older than the buffer, or the epoch differs) means: refetch rows.
- Heartbeat: a `ping` event every 15 s. The client reconnects with backoff (1 s doubling to 10 s)
  after an error or 30 s without any line, and refetches rows when it sees a gap.

| Type | Fields | UI |
|---|---|---|
| `stream.ready` | `tailSeq`, `resync`, `running: {turnId}|null` | history boundary |
| `ping` | | keep-alive |
| `turn.started` | `origin`, `clientId?`, `retry?`, `resync?` | working row on; with `retry` (and `resync`) the app re-reads the rows, since the failed attempt's rows are on an abandoned branch |
| `message.user` | `rowId`, `clientId?`, `text`, `attachments` | binds or appends the owner bubble |
| `message.queued` | `clientId`, `text` | queued tag |
| `message.dropped` | `clientId` | unsent bubble with Send again |
| `message.delta` | `rowId`, `delta` | streams the assistant bubble |
| `message.final` | `rowId`, `text` | authoritative text |
| `activity` | `kind: thinking|tool|compacting|retrying`, `tool?`, `detail?` | working label |
| `tool.call` | `callId`, `name`, `widget?` | live widget |
| `tool.result` | `callId`, `searchResults?` | search chips |
| `row` | full row | note, image, page, widget, card, unsent rows as written |
| `row.removed` | `rowId` | drops an assistant bubble Pi retried and hid from the model (a cut stream or a length recovery); the answer streams under the next row id |
| `input.requested` | `requestId`, `kind: "question"`, `prompt`, `options`, `allowFreeform` | question card |
| `input.resolved` | `requestId` | card leaves |
| `compaction.done` | `rowId` | note row |
| `turn.completed` / `turn.cancelled` | | working row off |
| `turn.failed` | `code`, `detail`, `retryAfterMs?`, `resetsAt?`, `messageKept`, `rowId` | failure row |

### 6.3 Pi event to protocol mapping

| Pi | Protocol |
|---|---|
| host accepts the prompt | `turn.started` |
| `message_start` user | `message.user` (row `<turnId>:u`) |
| `message_update` `text_delta` | `message.delta` (row `<turnId>:a<n>`, minted at the message's first text delta) |
| `message_update` `thinking_delta` | `activity thinking` (at most one per 500 ms) |
| `tool_execution_start` | `activity tool` + `tool.call` |
| `tool_execution_end` | `tool.result` |
| `message_end` assistant with text | `message.final` |
| `compaction_start` / `compaction_end` | `activity compacting` / `compaction.done` |
| `auto_retry_start` | `activity retrying` |
| `agent_settled` | `turn.completed` / `turn.cancelled` / `turn.failed` |

### 6.4 Refusal and failure codes

Refusals (HTTP, before a turn): `model_selection_unavailable`, `provider_route_retired {message}`,
`model_no_vision`, `description_too_long`, `context_too_large`, `retry_too_soon {retryAfterMs}`;
chat routes add `chat_busy` (delete while a turn runs) and `chat_not_found`.
Failures (`turn.failed`): every router code passes through (`circuit_open`, `upstream_*`,
`budget_exhausted`, `global_concurrency_limit` after its waits, and the rest of the router's
table), plus `engine_error`, `interrupted`, `refused`, `unreadable`. The Swift `TurnFailure` copy
keeps the router and provider entries and drops `session_busy`, `messages_count`, `historyBroken`
and the eve-only wording.

### 6.5 Engine internal API (web to engine only)

Same bearer and Host rules as 5.1. Writes are idempotent by the key given.

| Route | Body | Used by |
|---|---|---|
| `POST /internal/bots/:botId/rows` | `{chatId?, key, kind, ...row}` (no `chatId` = the bot's current chat) | connect notes, `noteProposal`, widget rows |
| `POST /internal/bots/:botId/system-turn` | `{key, text, note?}` | connect-card resume |
| `POST /internal/routines/:id/run` | | manual routine run |
| `GET /internal/bots/:botId/context` | | `/api/bots/context` (instruction cost against the window) |
| everything in 6.1 | | proxied |

## 7. Web service changes

| Area | Change |
|---|---|
| `web/app/eve/**`, `web/lib/eve-session-auth.ts`, `shared/eve-proxy.ts`, `shared/eve-stream.ts`, `shared/continuation-brief.ts` | delete; `parseTurnMessage`, `turnHasImages` and the attachment validators move to `shared/turn-input.ts` |
| `web/app/api/chats/**`, `web/app/api/engine/status`, `web/app/api/proposals` (new) | proxy to the engine with the same guards (`requireOwner`, CSRF, rate limits, 8 MB body cap renamed `TURN_BODY_MAX`) |
| `web/lib/agent-exec.ts` | delete the engine calls, routine and handoff pumps, channel JWT; keep connect pumps and the orphan sweep (widget rule 5.10) |
| `/api/agent/tick` | connect pumps and sweep only; `x-ub-agent-key` auth goes |
| `/api/agent/state` | delete |
| `/api/agent/widget` | body gains `chatId`; row through `/internal/bots/:botId/rows` |
| `/api/routines/:id/run` | calls the engine |
| `/api/status` | probes `GET <engine>/health`; field `engine` replaces `eve` (iOS contract fixtures updated in the same PR) |
| `/api/shell` | keep `renameBot`, `updateBot` (instructions, model, permission, workspace, notify, avatar), `setWorkspace`, `setPermission`, proposal confirm and dismiss; add `moveNotes {fromBotId}` and `removeArchivedBot {botId}` (Earlier bots); delete `select`, `createBot`, `deleteBot`, groups, sections, pin, hide, move, `sendToBot`, fan-out, `touchChat`, `setSession`, `clearThread`, `newChat`, `openRecent`, bot, group and profile proposals |
| `/api/approvals` | records carry `chatId` and `botId`; no session-binding lookup |
| `/api/bots/context` | from the engine |
| `/api/reviewer` | delete |
| `web/lib/image-regenerate.ts` | prompt from `media.json` |
| `shared/handoffs.ts`, `agents-send.ts`, `threads.ts` (move `stripThreadPrefix` out first, keep `DEFAULT_BOT_ID`), `subagent-stops.ts`, `bot-face.ts`, `session-bindings.ts` | delete |
| `shared/agent-store.ts` | keep connect proposals and idempotency reserves; delete threads, events and the other proposal kinds |
| `shared/workspace-store.ts` | grants keyed by `chatId`, written by the engine |
| `shared/admission.ts` | envelope from the engine (5.5.1); group branch gone |
| `shared/policy.ts` | drop `POLICY_EVE_VERSION`, rename `EVE_HOST` |
| `shared/connect-flow.ts`, `connection-flow.ts` | resume through the engine system turn; notes through the engine rows route |
| `shared/mcp-apps.ts` | widget detection from the tool-call shape |
| `shared/routines-store.ts` | routine gains `chatId` (its chat) and `movedFrom` (archive migration, PR 2); `RoutineRun` gains `chatId`; `parseRoutine` keeps the new fields |
| `/api/memory` | GET adds `total` (the store's `countLive`) for Earlier bots (PR 2) |
| `/api/connectors` | each connected app gains `needsSignIn` (its Composio account expired or failed auth) for the Sign in again chip (PR 2b) |
| `/api/connectors/tools` | each tool gains `risk` (`read`, `write` or `destructive`) from `connectorRisk` in `agent/lib/connector-risk.ts`, so the app page groups reads and writes (PR 2b) |

## 8. Router changes

- `validateCompletion`: accept `max_completion_tokens` as an alias; clamp max tokens to the
  model's output cap instead of refusing above 4096; clamp before the reservation.
- Accept and drop `store`, `reasoning_effort`, `prompt_cache_key`, `prompt_cache_retention`; map
  role `developer` to `system` (insurance against a wrong compat flag).
- Reasoning history: `withoutReasoning` and `rewrapThinkHistory` also handle `reasoning`,
  `reasoning_text`, `reasoning_details`; validate them.
- Delete `router/src/tool-finish.ts` and its three uses **in the engine-swap PR only** (eve needs
  it until then; Pi fails truncated tool calls on purpose).
- `scripts/restamp-registry.mjs` writes `sha256(package-lock.json)` into both
  `shared/registry.json` entries. Order for every dependency change: `npm install`, restamp, then
  build.

## 9. macOS app changes

File table with line counts: `app-map/swift.md` 5.2 and 6.2.

- **Rewrite:** `StreamProjection` (`EveStream.swift` 920-2433) becomes `ChatProjection` over rows
  plus 6.2 events (target under 450 lines). Keep and move `JSONValue`, `SearchChip`,
  `TurnActivity` (tool labels pruned to our 16 tools), `TurnFailure` copy (6.4), `SendFailure`,
  `OwnerQuestion`, `LiveWidget`, `parseSearchChips` (fed by `searchResults`).
- **BackendClient:** the eve section (about 600 lines) becomes the 6.1 requests and an NDJSON
  reader keyed by `seq`/`epoch` with the reconnect rules of 6.2.
- **AppModel:** the chat core (send, follow, reload, retry, cancel, queue, questions, background
  chats via `/api/engine/status`, notifications, Dock badge, reply ready) is rewritten for one bot
  and many chats; the per-bot runtime (bot selection, per-bot caches, rail hops), stash, prewarm,
  snapshots, sub-agent, handoff and the handoff pump go. The 2.5 s tick call stays.
- **Unsent messages** (`UnsentMessages.swift`) stay for refused sends and gain `message.dropped`
  and leftover queued messages.
- **Delete:** `ReplayGate.swift`, `ChatSnapshot.swift` and prewarm, `SubagentRuns.swift`,
  `SubagentCard.swift` (Core and App), `ChatAttribution.swift`, `AvatarStackView.swift`,
  `Threads.swift` except `defaultBotId`, and the eve-only tests (`app-map/swift.md` 7.1).
- **UI:** everything in `UI.md`: the chat-first sidebar (fixed Routines, Library and Connectors
  rows, chat list with per-chat state marks, row menu), an empty chat header, the
  Routines page on the stage, Settings > Personalization (instructions and memory) in place of the Bot pane (notify
  moves to Settings > General), the search palette (Chats, Library, Routines), Settings > General >
  Earlier bots, the Connectors polish of `UI.md` 8b, and the removals of `UI.md` section 10.
  Also: proposal cards keep connect kinds; Providers pane drops the reviewer row;
  `AppStatus.eve` becomes `engine`.
- **Supervisor:** `ServiceMode.eve` becomes `.engine`, health `/health`, `enginePort`, own-process
  pattern `agent/server.ts`. The eve patterns in `isStrayServiceLine` / `isOwnNodeProcess` stay for
  one release so an eve left from the old install is recognised and stopped. Order: router, engine,
  web.
- **Perf harness:** marks `rows_first_paint`, `rows_done` replace the replay marks; snapshot cases
  go.
- **First launch after the update:** one note in the empty chat: "Chats from the earlier version
  were not carried over. Your bot, notes, routines and connections are all here."

## 10. What the owner sees

- One bot (the current default). The sidebar lists chats, each showing whether it is working,
  waiting on him, has a reply or failed; Routines, Library and Connectors sit above the list.
- Other bots appear only under Settings > General > Earlier bots (copy instructions, move notes, remove);
  their routines are on the Routines page, paused, each with its own chat once it runs.
- Chats start fresh after the update; chats open from rows without the replay pause; chats can
  be renamed, deleted and searched by message text.
- A failed turn never kills the chat; Retry continues it.
- Sub-agent cards, group chats and bot-to-bot messages are gone; so is the reviewer role.
- OpenAPI connections show a note to re-add them as MCP servers.
- Approvals, questions, routines, connectors, images, pages, widgets, memory and model picking work
  as today.

## 11. Data

- **Carried unchanged:** `config.json`, `providers.json`, `models-cache.json`,
  `chatgpt-signin.json`, `limits.json`, `router/usage.sqlite`, `memory/` (minus `recall/`),
  `routines.json` (plus `chatId`, `movedFrom`, run `chatId`), `connections*.json`,
  `connectors.json`, `media.json` (plus `prompt`),
  `widgets/` (plus `chatId`, null for old ones), `web-sessions.json`, Keychain items.
- **Migrated:** `shell.json` to v2 (5.4), with archive flags (D6) set by PR 2.
- **Dropped by PR 3:** `agents.json` threads and events (after the image-prompt backfill),
  `handoffs/`, `subagent-stops.json`, `session-owners.json`, `policy.sqlite`, `memory/recall/`,
  `connection-tools.json` per-session picks.
- **Deleted by the runtime update:** `.eve/` under the runtime install (the rsync exclude goes).
- Migration runs once at engine boot, logged to `<stateRoot>/engine/migration.json`, idempotent.
  The dropped files above are moved into `<stateRoot>/engine/legacy/` rather than deleted (small,
  and recoverable if something was missed).
  `agent/engine/migrate.ts` (W1) orchestrates it and calls the store functions that do the work:
  the `shell.json` v2 migration in `shared/shell-store.ts` and the image-prompt backfill in
  `shared/media-store.ts` (both W3).
- Public users: the release notes say old chats are not carried over.

## 12. Security

- D4 lockdown, the `tool_call` name gate and the `~/.pi` contract test.
- Tools unchanged where it matters: seatbelt profiles, command risk, credential tripwires, path
  guards, planted-config refusal, whitelisted child env, untrusted fences, outside-content taint,
  approval hash binding, boot epoch. `<stateRoot>/engine/` is already covered by the `.useful-bot*`
  app-state deny (`shared/stack.ts:532-534`); no new rule needed.
- Engine: loopback only, bearer token, Host check, no Origin, explicit env (5.1).
- Pi phone-home off (5.1). The engine talks only to the router, the MCP servers and Composio the
  owner connected, and `web_fetch` targets.
- `pi-tui` native prebuilds ship in `node_modules`; ad hoc deep signing covers them today; they
  matter when notarization starts.

## 13. Ops, build, dependencies

- `package.json`: remove `eve`, `just-bash`, `ai`, `@ai-sdk/openai-compatible`, the `postinstall`
  and the `s1` script; add `@earendil-works/pi-coding-agent` and `turndown` (exact pins); `start`
  becomes `service.mjs engine`; `setup:dev` uses `UB_ENGINE_PORT`. Then restamp (8).
- `npm test` is an explicit file list: the orchestrator rewrites it in PR 3 (new `test/engine/**`
  files added, deleted tests removed).
- Rename table (owner: orchestrator's first commit in PR 3 unless noted): `shared/stack.ts`
  `evePort`/`eveOrigin`/`DAILY_PORTS`/`PORT_VARS`/`UB_EVE_PORT`; `shared/policy.ts`
  `POLICY_EVE_VERSION`, `EVE_HOST`; `scripts/service.mjs` mode, `servicePorts()` key (keep the port
  preflight), usage text; `package.json` `start`, `setup:dev`; `shared/launchd-render.ts` label
  `com.usefulbot.engine` and `ops/launchd/com.usefulbot.eve.plist`; `web/lib/api-guard.ts`
  `EVE_BODY_MAX`; `tsconfig.json` `types` (drop `eve/workflow-modules`); `.gitignore` eve lines;
  `scripts/setup-local.mjs` eve strings and the `sandbox: just-bash` pin; Swift `AppVariant`,
  `LocalServices`, `ServiceSupervisor`, `RuntimeInstall` and their tests (W4).
- Delete `scripts/patch-eve.mjs`, the eve cases in `scripts/verify.mjs`; rewrite
  `scripts/tool-schema-size.mjs` for our tools (baseline today: 19,487 authored chars; target
  under 15,000 for the 16 tools).
- `scripts/build-runtime.mjs`: tracked list loses `patch-eve.mjs`; `npm ci --omit=dev` carries
  Pi's tree (net disk roughly neutral).
- **Release smoke:** `scripts/smoke-runtime.mjs` also starts `agent/server.ts` from the staged
  runtime and requires `GET /health` with `stack` and `pi`.
- `perf/config.json` `ownProcesses`: the engine command line.
- iOS contract: `test/fixtures/ios-contract/status.phone-owner.json`,
  `scripts/ios-contract-fixtures.mjs`, `scripts/ios-pairing-gate.sh` follow the `engine` rename;
  `test/ios-contract.test.ts` stays green.
- `AGENTS.md`, `README.md`: the engine replaces eve in the shared-resources list, verification
  notes and runtime notes.

## 14. Verification

**Engine contract tests** (fake router upstream, `test/engine/`), before any UI integration:

1. Declared tools equal our names; no Pi built-in; no `~/.pi` path opened in a full turn.
2. `routerFetch` sends a fresh request id on each HTTP attempt, including Pi agent-level retries.
3. Pi's request body passes the router's validation with the 5.3 compat (golden payload).
4. A length stop after a tool call does not orphan a tool result; the next request is accepted.
5. Compaction never splits a tool call from its result; the summary call never hits
   `session_busy`.
6. Retry via `navigateTree` leaves one owner message on the active branch and `session.messages`
   matches it.
7. Kill the engine mid-turn; on boot the chat shows an `interrupted` row; Retry works.
8. Three quick sends: three turns, in order, each with its own `turn.started` and
   `turn.completed`; cancel drops the queued ones to unsent rows.
9. Every tool schema compiles with Pi's validator and accepts the lenient inputs.
10. An unregistered tool name is refused; `ask` plus another call in one batch is refused.
11. No outbound connection other than the router during a full turn.
12. Rows for a synthetic 15k-entry chat build in under 150 ms; rows after a compaction still
    contain every earlier message.
13. Cancel with a pending approval card returns within 1 s.
14. Seq survives session eviction; a reconnect with an old `after` gets `resync: true`.

**E2E** (Useful Bot Dev and its one bot, through the heavy lock, artifacts in `verify/<branch>/`, a
repeatable script plus mac-computer-use screenshots and 30 fps recordings): in one chat, attach a
folder and ask for a multi-step job that runs bash (one command needs approval, approve it),
writes an HTML page, searches the web, draws with Excalidraw (widget), generates an image and saves
a memory note; switch the model mid-chat; send two more messages while the first turn runs; cancel
one turn with a card pending; force a router 5xx (fake upstream connection) and Retry; push the
chat past a 32k window so it compacts; kill the engine mid-turn and relaunch; start a new chat,
then reopen the first one from the sidebar and check its note rows, connect cards and images are
all still there (on eve, New chat wiped them: PR 2b live pass, 2026-10-25); run a routine
manually while another chat is open (its row marks and the notification); rename, delete and
search for a chat; open a 15k-entry synthetic
chat. Artifact: a JSON report of every step with timings, the session files, screenshots, frame
sheets.

**Eval:** 10 golden tasks for the all-round bot (tool choice, approvals respected, memory, a
routine, a connector, a question, a long chat), run once on eve before the swap and once on Pi
after, same model, graded by rubric. Write-up `evals/results/<date>-pi-engine-golden.md` with
cost, latency and pass rate. The owner approves the spend first.

**Perf:** fixtures are synthetic Pi session files written by `scripts/perf-fixtures.mjs` (no paid
turns): four chats (Long Replies about 15k entries, Long Tools about 3.5k, Short A, Short B) of
the dev app's one bot, flagged `fixture: true` in the chat index (listed by the perf harness only,
never in the sidebar; the dev stack only). The old fixture bots are archived like any earlier bot. Re-lock, re-baseline, review budgets for `rows_first_paint` and
`rows_done`; raise a budget only in a reviewed edit that says why. Done inside PR 3, so `main` is
never red.

## 15. Keep, adapt, delete

The complete per-file list with owners is the ownership table in `PLAN.md`.

- **Keep:** router (minus 8), `command-risk.ts`, `sandbox.ts`, `run-command.ts`, `workspace.ts`,
  `cli-registry.ts`, `connector-risk.ts`, `memory.ts`, `notes-block.ts`, approvals store (plus the
  abort signal), routines store, Composio, MCP client and OAuth, media and widget stores, auth
  stack, Keychain, `dir-lock.ts`.
- **Adapt:** every tool file (shim, ctx), `router-fetch.ts`, `router-identity.ts`, `permission.ts`,
  `outside-content.ts`, `write.ts`, `turn-snapshot.ts` (`buildSnapshot` only), `context-blocks.ts`,
  `admission.ts`, `shell-store.ts`, `shell-io.ts`, `agent-store.ts`, `workspace-store.ts`,
  `connection-tools*.ts`, `mcp-apps.ts`, `connect-flow.ts`, `connection-flow.ts`,
  `image-regenerate.ts`, the web routes in 7, the Swift files in 9.
- **Delete:** `agent/agent.ts`, `agent/channels/`, `agent/connections/registry.ts`,
  `agent/hooks/`, `agent/sandbox/`, `agent/memory/notes.ts` (renderer moves),
  `agent/instructions/context.ts`, `session-model.ts`, `channel-auth.ts`, `session-owners.ts`,
  `active-bot.ts`, `openapi-approval.ts`, `web-fetch-fence.ts`, `plant_read.ts`, the D20 tools,
  the web and shared files in 7, the Swift files in 9, eve-only tests.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Pi API churn (5 minor releases in 3 weeks, embedder breaks) | exact pin; all Pi calls behind `pi-host.ts`; upgrades in their own PR with the contract tests |
| Pi changes direction (Earendil; parts may go source-available) | MIT core pinned; the adapter keeps a later swap possible |
| Pi's coding-agent defaults | D4 and contract tests 1 and 11 |
| No mid-turn durability | interrupted row and Retry; image and proposal reserves keep tools idempotent |
| Router refuses Pi's requests | router changes in 8, golden payload test |
| Compaction quality differs from eve | the eval includes a long chat; `session_before_compact` can supply a custom summary |
| Owners with several bots lose personas | Earlier bots keeps their instructions (copy) and notes (move); their routines move to the one bot, paused, for review |
| Big Swift rewrite | the protocol and fixtures come first; the client is built against fixtures |

## 17. Glossary

- **Chat:** one Pi session file. **Turn:** one prompt until Pi settles. **Row:** a rendered
  transcript item. **Epoch:** engine boot id. **Selection:** `{connectionId, modelId, effort,
  speed}`, frozen per turn. **Envelope:** system prompt + per-turn context + tool schemas + 4,096
  output tokens.
