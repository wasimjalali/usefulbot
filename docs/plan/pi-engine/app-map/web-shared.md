# Map: `web/` (API service) and `shared/` (modules)

Repo `/Users/wasimjalali/Desktop/useful-bot`, branch `main` @ 9dc43a0f. Read-only pass. All paths below are relative to the repo root unless absolute. `web/.next/standalone/**` is a build copy of the same files; ignore it.

Conventions: `E` = eve; `L` = line; "state root" = `stateRoot()` = `$UB_STATE_ROOT` else `~/.useful-bot` (dev stack: `~/.useful-bot-dev-app`), `shared/stack.ts:101`. Ports daily/dev: router 4319/4419, web 4320/4420, eve 4321/4421 (`stack.ts:31-38`, `package.json setup:dev`). Classification tags: KEEP, ADAPT, REMOVE-EVE, REMOVE-MULTIBOT, UNSURE.

Not verified (no code or doc evidence read): that Pi never retires a session after a failed turn; Pi's ChatGPT subscription login; the exact on-disk layout of eve's `.eve/` chunk files (only known from comments: `stack.ts:541`, `BackendClient.swift:2141`).

---

## 0. Shape of the service in one paragraph

`web/` is a Next 16 app (`web/next.config.ts`, `output: "standalone"`) bound to loopback. It has no UI. It is (a) a thin authenticated proxy in front of eve (`web/app/eve/v1/[...path]/route.ts`, 603 L, the only place that talks eve's HTTP API for the app), (b) CRUD over a dozen JSON stores that live in `shared/` and are also written by the eve agent process (`agent/tools/*`), and (c) an in-process "pump" runtime (`web/lib/agent-exec.ts`, 1707 L) that runs handoffs, routines, connect cards and an orphan sweep, driven by the app POSTing `/api/agent/tick` every few seconds (`AppModel.swift:1690-1694`, `BackendClient.swift:1481`). There are two writer processes per store (web + eve agent), which is why every store has an atomic-rename + lock convention. All engine traffic is HTTP to `http://127.0.0.1:<evePort>/eve/v1/*` with a per-bot HS256 JWT. No route reads `.eve/` files; transcript reads go through eve's stream endpoint only.

---

## 1. Route table

36 route files, 57 method handlers. "Gate" = `requireOwner` (`web/lib/desktop-gate.ts:56`: cookie session -> ingress -> profile -> credential -> origin). "CSRF" = `x-ub-csrf` header must equal `session.csrf`. Every state-changing handler checks CSRF; most also take a `rateLimited(...)` bucket (not `/api/memory` DELETE, `/api/agent/media/<id>` POST/DELETE, `/api/agent/tick` GET).

Hits-from-app column: does `macos/Sources` call it (grep of path string).

| Method + path | What it does | Shared / lib modules | Engine link | App calls | Class |
|---|---|---|---|---|---|
| GET `/` (`web/app/route.ts:6`) | `{ok, service, stack}` | stack | none | no | KEEP |
| GET `/api/health` | `{ok, stack}` for HealthPoller; no gate | stack | none | yes (`ServerConfig.swift:55`) | KEEP |
| GET `/api/status` (27 L) | operator name/initials, app version, apiVersion, profile, and `eve: available/limited` | operator, stack | **HTTP GET `{eve}/eve/v1/health`, 1.5 s timeout** (`status/route.ts:12`) | yes; `AppStatus.eve` feeds `runtimeDown` (`BackendModels.swift:941`) | ADAPT (replace the probe with Pi engine liveness; keep the field name or change both sides) |
| POST `/api/auth/session` (198 L file) | Mint cookie session from `Authorization: Bearer <device token>`; returns `csrfToken`, `expiresAt` | lib/auth, cookie-sessions, web-sessions, ingress, runtime-config | none | yes (`BackendClient.swift:435`) | KEEP |
| GET `/api/auth/session` | Introspect; or auto-mint a `desktop` session for a same-origin loopback page (browser-era path, `auth/session/route.ts:66-92`) | same | none | introspection only | KEEP (auto-mint branch is browser-UI legacy: UNSURE) |
| DELETE `/api/auth/session` | Logout, clears cookie | same | none | yes | KEEP |
| GET `/auth/callback` (118 L) | Loopback landing for Sign in with ChatGPT: completes PKCE exchange, writes credential to providers store, syncs model list; returns HTML | chatgpt-signin, providers, provider-catalog, origin, lib/providers-write, lib/sync-models | none (OpenAI, not eve) | browser redirect (not app HTTP) | KEEP |
| GET `/eve/v1/[...path]` | Allow-listed: `health`, `info`, `session/<id>/stream` only (`eve-proxy.ts:27-30`). Pipes eve's NDJSON body back; forwards `x-eve-stream-tail-index` (`route.ts:519`). Child-stream reads need `?parent=&at=` and are verified against the parent's `subagent.called` event | eve-proxy, eve-stream, session-bindings, lib/eve-session-auth, lib/agent-exec (channelJwt) | **HTTP GET to eve, Bearer per-bot JWT** | yes (`BackendClient.swift:2292`) | REMOVE-EVE (the wire contract moves to Pi, see section 6) |
| POST `/eve/v1/session` | Create session + first turn. Body `{message, botId, continueFrom?, retry?}`. Validates, rewrites body (hidden notes), admission, binds new session, stamps workspace grant | eve-proxy, threads, shell-store/-io, session-bindings, session-selection, providers, live-models, models, admission, continuation-brief, workspace-store, subagent-stops, lib/agent-exec, lib/eve-session-auth, agent/lib/approvals | **HTTP POST to eve** (180 s cap, `route.ts:490`) | yes (`BackendClient.swift:1548`) | REMOVE-EVE |
| POST `/eve/v1/session/<id>` | Send a turn into an existing session, or answer an input request (`{inputResponses:[{requestId,optionId}]}`) | same | HTTP POST to eve | yes (`send`, `answerInput` :1622) | REMOVE-EVE |
| POST `/eve/v1/session/<id>/cancel` | Cancel the active turn; `?scope=report` and `?parent=&at=&agentId=` variants; expires that session's approval cards (`route.ts:78-90`) | same + ApprovalStore | HTTP POST to eve | yes (`cancel` :1242, `cancelChild` :1258) | REMOVE-EVE (child variant also REMOVE-MULTIBOT) |
| GET `/api/agent/state?botId=` (19 L) | Durable overlay for the open chat: `{events, proposals}` from `agents.json` | agent-store | none | yes (4 call sites in `AppModel.swift`) | ADAPT (events keep; proposals keep only connectApp/connectServer) |
| POST `/api/agent/tick` (120 L), GET same | The pump. Auth: `x-ub-agent-key` header (== `UB_CHANNEL_JWT*` sha256) **or** owner cookie + Origin/CSRF (`tick/route.ts:41-55`). POST runs `sweepOrphanStateIfDue`, drops legacy device-flow file, then fire-and-forget `pumpHandoffs`, `pumpRoutines`, `pumpConnects`, `pumpConnections`, `seedDefaultConnections`; returns `workingBotIds`, `routinesInFlight`, `inFlight` | lib/agent-exec, connect-flow, connection-flow, connections-store, provider-oauth | indirect (handoff and routine delivery are HTTP to eve) | yes, every few seconds (`BackendClient.swift:1481`) | ADAPT (drop `pumpHandoffs`; routines/connects stay; the resume mechanism needs a non-handoff path, see section 4) |
| GET, PUT `/api/shell` (539 L) | GET returns the whole `shell.json`. PUT = one `ShellAction` (+ optional proposal confirm/dismiss). Side effects: grants revoked/restamped, `clearThread` empties the agents.json thread, `deleteBot` detaches routines/thread/bindings, fan-out queues handoffs, connect cards start OAuth | shell-store/-io, agent-store, threads, session-bindings, routines-store, workspace-store, providers, connect-flow, connection-flow, lib/agent-exec | none directly | yes (touchChat, newChat, clearThread, setWorkspace...) | ADAPT (hollow out the roster; see section 8) |
| GET `/api/bots/context?botId=` | Instruction counter: description chars, envelope tokens vs model window, Generalist seed diff | lib/agent-exec (`botContextReport`), admission, shell-store | none | yes (`BackendClient.swift:1444`) | ADAPT or REMOVE (envelope math is built from eve's prompt size constants, `admission.ts:29,36`) |
| GET `/api/approvals` | List pending approval cards for the app (polled ~1.5 s, `AppModel.swift:953`); each card gets `botId`/`botName` via `resolveSessionBot` | agent/lib/approvals (`ApprovalStore`), shell-io, session-bindings | none (file store) | yes | ADAPT (drop bot resolution, `rootSessionId`, `subagent`) |
| POST `/api/approvals/<id>` | Decide `{decision: approve\|deny, actionSha256}` | ApprovalStore.decide | none | yes (`decideApproval`) | KEEP |
| GET/PUT/DELETE `/api/providers` | Provider/connection store: composer state per bot, keys, active connection, per-bot model pick, live model lists; PUT validates a pasted key against the vendor | providers, provider-catalog, session-selection, live-models, chatgpt-signin, lib/providers-write, lib/sync-models, shell-io | none (router is the model path) | yes | ADAPT (credentials must reach Pi's model runtime; per-bot parts shrink) |
| POST `/api/providers/oauth`; POST/DELETE `/api/providers/oauth/<pollId>` | Start / poll / cancel the ChatGPT browser sign-in | chatgpt-signin, providers, lib/providers-write | none | yes | KEEP (UNSURE if Pi's own login replaces it) |
| GET/PUT `/api/usage` | 24 h and 7 d token meter and daily budgets, read from the **router's** `usage.sqlite` (`router/src/limits.ts`) | limits-store, providers, stack, router/src/limits | none | yes | UNSURE (depends on whether the router survives) |
| GET/POST `/api/routines`; PATCH/DELETE `/api/routines/<id>`; POST `/api/routines/<id>/run` | Routine CRUD (`?botId=` or `?id=`), and manual "Test run" which claims then runs in background | routines-store, shell-io, lib/agent-exec (`startRoutineNow`) | run route -> eve turn via `runEveTurn` | yes | ADAPT (engine call changes; botId param only) |
| GET/DELETE `/api/memory` | Notes per bot (`MemoryStore`, sqlite), list/read/archive with revision check | agent/lib/memory.ts | none | yes | KEEP (botId param stays if 2 bots) |
| GET/POST `/api/workspace` | Project recents for the composer chip (`addProject`/`removeProject`) | workspace-store, shell-store (`isGrantableRootPath`) | none | yes | KEEP |
| POST `/api/attachments` | Multipart upload, returns text and/or image data URL for the turn | attachments | none | yes | KEEP |
| GET `/api/agent/media`; GET/POST/DELETE `/api/agent/media/<id>` | Library of generated images, drawings, pages; relink, forget | media-store, images-store, lib/media-migrate | none | yes | KEEP (`botId` filter is metadata) |
| GET `/api/agent/image/<id>`; POST `/api/agent/image/<id>/regenerate` | Image bytes; paid redraw from saved prompt via router | media-store, images-store, lib/image-regenerate, agent-store (reads `agents.json` for the prompt) | none (router `/v1/images`) | yes | KEEP (image-regenerate reads agents.json threads: ADAPT if the overlay moves) |
| POST `/api/agent/widget` | App posts an MCP-app (Excalidraw) widget back; stored in `widgets/`, appended to the thread as a `widget` event, drawing copied to Library | mcp-apps, widgets-store, agent-store, connections-store, media-store, shell-io | none | yes | ADAPT (the "append event to thread" step) |
| GET `/api/connections/widget/<id>`; POST `.../<id>/call` | Widget host HTML; widget's own `tools/call` against an auth-less MCP server | mcp-app-host, widgets-store, mcp-http, connections-store | none | yes | KEEP |
| GET/POST/DELETE `/api/connections`; GET `/api/connections/callback` | Direct MCP/OpenAPI server connections: list, refresh, re-authorize, remove; OAuth return page | connections-admin, connections-store, connection-flow, mcp-oauth, origin | none | yes | KEEP |
| GET/PUT/POST/DELETE `/api/connectors`; GET `.../tools`; GET/POST `.../own-app`; GET `.../callback` | Composio catalogue and connections | connectors-store, composio, composio-catalogue | none | yes | KEEP |
| POST `/api/reviewer` | Ask the reviewer model through the router; fixture text when `UB_ROUTER_REVIEWER_TOKEN` is unset | stack | none (router `/chat/completions`) | **no caller in `macos/Sources`**; only named in `docs/spec/IOS-APP-SPEC.md:545`. The agent's `review` tool calls the router itself | UNSURE (dead candidate) |

Per-route auth deviations worth knowing:
- `/api/agent/tick` is the only route that also accepts a non-cookie key (`x-ub-agent-key`), used by `wakePump` in `shared/agents-send.ts:135-148` (agent process -> web).
- `/api/auth/session` POST/DELETE have no cookie gate (they are the gate); they have their own per-source rate buckets (`auth/session/route.ts:134,184`).
- GET routes (state, approvals, routines GET, memory GET) need the session cookie but no CSRF.
- `/api/health` and `/` need nothing.
- `web/lib/desktop-gate.ts:65` `requireDesktop` has zero callers (dead).

---

## 2. Module table: `shared/*.ts` (64 files incl. `registry.json`)

Durable state column: file under state root unless noted. "Fmt" = format. All JSON stores are 0600, atomic tmp+fsync+rename; locking is either a `mkdir <file>.lock` dir (8 s timeout, 3 s stale; copy-pasted in shell-io, web-sessions, agent-store, routines-store, workspace-store, approvals) or the SQLite-backed `dir-lock.ts` (session-bindings, connection-auth, memory).

### 2a. Session, bot, transcript core (the migration surface)

| Module (L) | Purpose | Durable state | Class |
|---|---|---|---|
| `eve-proxy.ts` (391) | Allow-list regexes for eve paths (:22-39); `relayedEveCode` (only `session_not_active` escapes, :48); `parseTurnMessage` (string or text+image parts, :114); `parseInputResponses` (:157); child stream/cancel query parsing (:196-241); `eveSessionRoute` + mention parsing (:258-291); `rewriteEveTurnBody` hidden-prefix injection (:314-339); `parseTurnExtras` continueFrom/retry (:348); `x-ub-route` header encode/decode (:363-391) | none | REMOVE-EVE. Carry: `parseTurnMessage`, `turnText`, `turnHasImages`, `parseInputResponses` as engine-neutral validators |
| `eve-stream.ts` (264) | NDJSON line parser (`eveStreamPayload`, `takeStreamLines`, `parseEveStreamLine`) used by the carry-over reader and child verification; plus a `StreamProjection`/`applyEveEvent`/`consumeEveNdjson` chat projector | none | REMOVE-EVE. The projector half (:23-264 minus the parsers) is imported only by `test/eve-stream.test.ts` (grep): dead in production, the Swift app has its own (`EveStream.swift`, 2537 L) |
| `session-bindings.ts` (375) | Immutable `sessionId -> botId` identity record, plus sub-agent `parentId`, roster-pointer backfill with ambiguity logging, `sessionCarriesOverFor`, `unbindBot` | `session-owners.json`: `{schemaVersion:1, sessions:{<id>:{botId, createdAt, parentId?}}}`, strict parse, readers treat a bad file as empty (fail closed), writers back it up as `.invalid.*`. dir-lock | REMOVE-MULTIBOT (ownership across bots), REMOVE-EVE (eve channel binding). With 1-2 bots a trivial "which bot owns this session" is enough |
| `session-selection.ts` (150) | `ModelSelection {connectionId, modelId, effort, speed}`; `lastPick`, `botSelection` (bot.model else last pick); `x-useful-selection` header codec for the router (:28-90) | none | ADAPT (per-bot model stays; header codec is router-only) |
| `threads.ts` (214) | @mention parser, group/route resolution, roster lines, `stripThreadPrefix` for legacy identity prefixes (:181-195), `speakerLabel` | none | REMOVE-MULTIBOT (all but `stripThreadPrefix`, which only exists to hide eve-era prefixes) |
| `continuation-brief.ts` (247) | Build a one-line-per-entry brief of a dead eve session from its stream events; `withSessionNotes` hidden prefix; `RETRY_NOTE`; `settledByBriefTurn` | none | REMOVE-EVE (exists because "eve has no way to fork or import history", :5-6). `RETRY_NOTE` text and the hidden-note idea survive as a Pi `custom_message` |
| `agents-send.ts` (148) | `sendHandoff` (queue + two transcript rows + `wakePump`), `writeHandoffReply` | none (writes handoffs + agents.json) | REMOVE-MULTIBOT |
| `handoffs.ts` (419) | Durable bot-to-bot queue: claim/lease, attempts max 3, depth max 3, 14 d retention | `handoffs/<id>.json`, one file per record, `HANDOFF_SCHEMA=1`, claim token with 10 min stale | REMOVE-MULTIBOT. Also used as the connect-card "resume" carrier (`connect-flow.ts:128`, `connection-flow.ts:122`): that use needs a replacement |
| `agent-store.ts` (968) | Durable **overlay** next to the engine transcript: per-bot thread events, proposals (cards), idempotency reserves | `agents.json`: `{schemaVersion:1, threads:[{id,kind,botId,sessionId,updatedAt,events[<=300]}], proposals[], reserves[]}`. Event kinds: user, assistant, handoff, post, note, proposal, widget, image, page (:40-50). Proposal TTL 24 h | ADAPT. Keep: note/widget/image/page events, connectApp + connectServer proposals, image reserve. Remove: handoff/post events, BotProposal/GroupProposal/ProfileProposal/FanoutProposal (:87-139), `nextPetname`, `createProfileProposalOnce` |
| `shell-store.ts` (1365) + `shell-io.ts` (235) | The roster: bots, groups, sections, pins, hide, recents, selected bot, per-bot session pointer + lineage, per-bot workspace/permission/model, avatar, seed text; `applyShellAction` reducer (:822-1256); reseed/recovery marker logic in shell-io | `shell.json`: `{schemaVersion:1, selectedBotId, collapsedUnassigned, collapsedHidden, bots[], sections[], recents[<=40]}`; `shell.json.reseeded` marker; `.invalid.*` backups; mkdir lock | ADAPT. See section 8 for what leaves |
| `admission.ts` (166) | Refuse a turn whose fixed envelope (prompt + context blocks + notes + tool schemas + brief + 4096 output) exceeds the model window | none | ADAPT/UNSURE. Constants `SHARED_PROMPT_CHARS=9100` (:29), `TOOL_SCHEMA_CHARS=30000` (:36) were measured on eve's wire (comment :21-35); Pi's prompt and tool list differ. Pi exposes `session.systemPrompt` (sdk.md) so the estimate could be measured |
| `context-blocks.ts` (198) | Pure renderers: "Running the team", "Your bot", "Your group", "This turn" system blocks | none | ADAPT (drop team + group blocks) |
| `notes-block.ts` (105) | Renders the bot's memory cards as a deterministic block | none (reads cards passed in) | KEEP |
| `subagent-stops.ts` (50) | Owner-stopped sub-agent markers so the parent is told | `subagent-stops.json`, TTL 1 h, 64 rows | REMOVE-MULTIBOT (sub-agents dropped) |
| `workspace-store.ts` (348) | Per-session "grants" (folder + permission + stamped model; cap 64, `GRANTS_MAX`) written by web at turn time and read by the agent process at tool time; plus project recents (cap 12) | `workspace.json`: `{schemaVersion:1, grants[], projects[]}` | ADAPT. Grants exist only because two processes must agree; in-process Pi tools can read the bot config directly. Projects KEEP |
| `routines-store.ts` (819) | Routines, schedules (weekly/daily/once, IANA zone, DST-safe), claims, run history (<=20), manual-run flag | `routines.json`: `{schemaVersion:1, routines[], extra?}`; unknown fields round-trip in `extra` | KEEP |
| `bot-face.ts` (68) | Avatar shape/colour vocab and parsers. Header says "Clients render only the mascot" (:3) | none | REMOVE-MULTIBOT (wire compat for per-bot avatars) |
| `attachments.ts` (178) | Attachment limits, MIME sniffing, safe names, turn-part types | none | KEEP |
| `widgets-store.ts` (117), `mcp-apps.ts` (87), `mcp-app-host.ts` (344) | MCP App (Excalidraw) widget payloads, extraction from an eve action event, host HTML page | `widgets/<id>` 0600 file per widget | KEEP (`mcp-apps.ts` parses an eve `action` event shape: ADAPT) |
| `media-store.ts` (665), `images-store.ts` (118) | Library of generated images/drawings/pages as real files under `~/Documents/Useful Bot` (`UB_MEDIA_DIR`), with an index; legacy base64 image records | `media.json` index (+ files outside the state root); legacy `images/<id>.json` | KEEP |

### 2b. Auth, config, stack

| Module (L) | Purpose | Durable state | Class |
|---|---|---|---|
| `web-sessions.ts` (145) | Server-side browser session records keyed by sha256(cookie token), 12 h | `web-sessions.json` `{sessions:{<sha256>:{callerId,profile,csrf,expiresAt,credentialId}}}`, mkdir lock | KEEP |
| `runtime.ts` (151) | Loads the router's `config.json` (`UB_ROUTER_CONFIG`): credential digests (kind device/channel/router, sha256, expiry, revoke), tailnet/phone block, limits per profile | `<stateRoot>/config.json` (owned by `scripts/setup-local.mjs`) | KEEP, but note the **device credential store lives in the router's config**; if the router goes, move it |
| `origin.ts` (32) | Loopback host/Origin checks | none | KEEP |
| `stack.ts` (570) | Single source for state root, ports, Keychain prefix, dev/daily isolation, app-state path screens | none | KEEP |
| `dir-lock.ts` (100) | SQLite `BEGIN EXCLUSIVE` cross-process lock | `<lock>.sqlite` next to stores | KEEP |
| `keychain.ts` (116) | Keychain items via `security -i` | Keychain `com.usefulbot[.dev].*` | KEEP |
| `operator.ts` (68) | Mac account full name, app version | none | KEEP |
| `user-path.ts` (185), `sandbox.ts` (67), `launchd-render.ts` (122), `fold-path.ts` (10), `untrusted.ts` (31) | owner PATH for commands; sandbox backend pick; launchd plist render; path folding; untrusted-output envelope | none | KEEP (agent-tool / ops helpers; not on the web route path) |

### 2c. Providers and models (router-coupled)

| Module (L) | Purpose | Durable state | Class |
|---|---|---|---|
| `providers.ts` (1764) | Provider store v2: connections, credentials (key or oauth), active connection, last pick, roles (reviewer/image), composer state, availability, `resolveUpstream` | `providers.json` (`schemaVersion:2`; keys in this file; header says `@deprecated Slice 2` for the legacy API :1) | ADAPT: Pi has its own `ModelRuntime` and `auth.json` (providers.md); a bridge or replacement is a spec decision |
| `provider-catalog.ts` (777), `models.ts` (515), `live-models.ts` (503) | Catalogue of vendors/modes, model options, live model list fetch and cache (models.dev context windows) | `models-cache.json` | UNSURE (Pi ships its own model catalog) |
| `provider-oauth.ts` (55), `chatgpt-signin.ts` (978) | ChatGPT PKCE sign-in, refresh, revoke; removed Copilot flow remnant | `chatgpt-signin.json` (attempt + issued-client registration, 0600) | KEEP (UNSURE vs Pi `/login`) |
| `limits-store.ts` (313), `policy.ts` (337), `contracts.ts` (31), `usage-parse.ts` (81), `inline-think.ts` (93), `registry.json` | Daily budgets, designed limits, router caller/alias types, usage parser, `<think>` splitter, router model registry | `limits.json` | UNSURE: all router-side concerns. `policy.ts` also carries `POLICY_EVE_VERSION="0.54.3"` (:23), sandbox/path deny lists and tool budgets used by agent tools |

### 2d. Connections and connectors (engine-independent catalogue, eve-specific mounting)

| Module (L) | Purpose | Durable state | Class |
|---|---|---|---|
| `connections-store.ts` (340), `connections-admin.ts` (181), `connection-flow.ts` (822), `connection-auth.ts` (253), `connection-url.ts` (231), `connection-icons.ts` (295), `mcp-oauth.ts` (708), `mcp-http.ts` (721) | Direct MCP/OpenAPI servers: registry, admin actions, connect card flow, auth headers, SSRF-safe URL rules, favicon cache, MCP OAuth (PKCE, DCR), Streamable HTTP client | `connections.json`, `connection-icons.json` (data URIs), `connections-oauth.json` (pending PKCE, 0600); secrets in Keychain | KEEP (catalogue/OAuth). Header of `connection-auth.ts:2-4` says "eve owns this for the connections it mounts" |
| `connection-tools.ts` (781), `connection-tools-store.ts` (760), `tool-wire-size.ts` (321), `json-schema-zod.ts` (190) | On-demand tool mounting: which connections are eager, `find_tools` index, per-session picks, tool-schema byte budgets, JSON Schema -> zod for eve | `connection-tools.json` (index + per-session picks) | ADAPT/UNSURE: the budgets exist because eve/router retire a session on an oversize tool array (`tool-wire-size.ts` header). Pi has `tool_search`/MCP extension (sdk.md) |
| `composio.ts` (794), `composio-catalogue.ts` (182), `connectors-store.ts` (226), `connect-flow.ts` (251) | Composio Tool Router: key, user id, session id, catalogue cache (1 day), connect card pump | `connectors.json` (API key, 0600), `composio-catalogue.json` | KEEP. `connect-flow.ts` and `connection-flow.ts` queue a **handoff** to wake the bot after OAuth completes (replace that carrier) |

---

## 3. Session lifecycle today

Actors: A = macOS app (`BackendClient`), W = web proxy (`web/app/eve/v1/[...path]/route.ts`), E = eve (port 4321), S = state files.

### 3a. First message of a new chat (session create)
```
A  (freshSession) historySnapshot skipped; POST /eve/v1/session {message, botId, continueFrom?, retry?}  + cookie + x-ub-csrf
W  requireOwner -> csrf (route.ts:104-107) -> rate 60/min per caller -> allow-list (evePostAllowed)
W  readBody <= 8 MB (api-guard.ts:13); suffix==="session" skips authorizeEveCall
W  parseTurnExtras; if continueFrom: continueFromVerdict(bot,..) + sessionCarriesOverFor(..) else 400 continue_from_refused / 409 session_moved
W  parseTurnMessage; image part + model without vision -> 400 model_no_vision
W  modelSelectionRefusal(bot) + admissionRefusal(bot,...)  -> 409 model_selection_unavailable | provider_route_retired | context_too_large | description_too_long
W  (carry-over) continuationBriefFor(old session) -> reads E stream (see 3d)
W  eveSessionRoute(raw, shell)  -> bot must be on roster else 400 eve_bot_missing; builds hidden notes; rewriteEveTurnBody
W  finalRefusal = same checks again with the real hidden prefix size
W  jwt = channelJwt(route.threadId)  (HS256, botId claim)       agent-exec.ts:408
W  POST E /eve/v1/session   (timeout 180 s)                      route.ts:493
E  creates session, starts turn, answers {sessionId}
W  bindSession(sessionId, botId)  -> session-owners.json; on failure cancelEveTurn + 503 session_bind_failed   route.ts:539-544
W  (carry-over) updateShell(carryOverLineage) -> bot.previousSessionIds (<=5), continuedSessionId, continuationSettled=false, sessionId=new; removeSessionGrant(old); lost race -> cancel new + 409 session_moved
W  syncSessionWorkspace(created, bot, store) -> workspace.json grant {path, permission, selection}
W  returns E's JSON body  (x-ub-route header only on non-create responses, route.ts:595-598)
A  PUT /api/shell {action:{type:"touchChat", botId, preview, sessionId}}  -> shell.json bot.sessionId / lastPreview / lastAt (shell-store.ts:1147)
A  GET /eve/v1/session/<id>/stream?startIndex=0  (follower; see section 6)
```
### 3b. Message into an existing chat
```
A  GET .../stream?startIndex=<cursor>&includeTailIndex=1 until tail  -> historySnapshot: turnIds seen + nextIndex = tail+1   (AppModel.swift:2185, BackendClient.swift:2118)
A  POST /eve/v1/session/<id> {message, botId}
W  authorizeEveCall: bot comes from resolveSessionBot(<id>) NOT the body; unbound -> 400 session_unbound; body botId != bound -> 400 session_bot_mismatch;
   recorded sub-agent child -> 403 child_session_readonly       eve-session-auth.ts:29-57
W  same refusals/admission as 3a; syncSessionWorkspace(<id>, bot) BEFORE forwarding (route.ts:456-466)
W  if bot.continuedSessionId==<id> && !continuationSettled: sessionHasCompletedTurn(<id>) reads head 400 + tail 20000 events; if not settled re-attach the old brief; if settled updateShell(settleContinuation)
W  POST E /eve/v1/session/<id> with Bearer channelJwt(bound)
E  eve channel turnPolicy "queue" (agent/channels/eve.ts): a send during a turn queues
A  GET .../stream?startIndex=<nextIndex>; arms on the new turn id / matching message text; ends at turn.completed|cancelled|session.waiting
A  PUT /api/shell touchChat (preview + session id)
```
Input request answer: same POST path with `{botId, inputResponses:[{requestId, optionId}]}` (validated by `parseInputResponses`, `eve-proxy.ts:157`; body rebuilt from validated fields, `route.ts:224-232`).

### 3c. Retire / 409 session_not_active
- eve answers 409 `{code:"session_not_active"}` for a session that failed or was retired (a failed turn retires it, `eve-proxy.ts:41-47`). W relays only that one code: `{ok:false,error:"eve_error",status:409,code}` (`route.ts:497-511`) and calls `retireCards` (expires that session's approval cards).
- A catches it as `BackendError.sessionEnded` (`BackendClient.swift:1585`) and re-posts as a fresh session with `continueFrom=<dead id>` (`AppModel.swift:2226-2249`). The pointer is not dropped first: W verifies `continueFrom` against `bot.sessionId`/`continuedSessionId`/`previousSessionIds`.
- W reads the dead session through E's stream (3d), builds `buildContinuationBrief`, prepends it as hidden "Session note: the lines below come from the app" text (`continuation-brief.ts:205-210`) to the first message. The Swift transcript strips that prefix.
- Server-driven turns do the same in `runEveTurn` (`agent-exec.ts:897-975`): on 409 + `session_not_active`, join the owner's live session if the pointer has moved, else carry over and `updateShell` with `recordSessionLineage`.

### 3d. How the brief reads an old session
`readSessionEvents` (`agent-exec.ts:673`): two stream reads, head 400 events from `startIndex=0` and the last 20 000 events, using `includeTailIndex=1` and the `x-eve-stream-tail-index` response header; 3 s idle / 15 s hard / 48 MB caps (`CARRY_READ`, :587). A failed read yields a brief that says the context was lost.

### 3e. Cancel
`POST /eve/v1/session/<id>/cancel` -> authorize (an unbound session may still be cancelled, with a no-bot JWT, `eve-session-auth.ts:47-50`) -> forward -> on success `ApprovalStore.expireSession(<id>, {children})` (`route.ts:84-89`; `children` false only for `scope=report`). Server-side give-up path: `cancelEveTurn` (`agent-exec.ts:791`).

### 3f. Clear history / new chat
- Clear: `PUT /api/shell {action:{type:"clearThread", botId}}` -> reducer sets `sessionId=null`, clears preview, pushes a recent (`shell-store.ts:1188`) -> `revokeGrantsFor` (grant of the dropped session) -> `applyFollowUp` -> `clearThread(botId)` empties the `agents.json` thread (`shell/route.ts:71-73`). **The eve session is not cancelled or deleted**; it is just orphaned (its `.eve` data stays; its binding row stays in `session-owners.json` until the bot is deleted).
- New chat: `newChat` action: pointer null, recent pushed (`shell-store.ts:1170`); the agents.json thread is not cleared (a separate action).
- Reopen: `openRecent` restores `recent.sessionId` as the pointer (:1204).
- Delete bot: `deleteBot` then `detachBot` (routines, thread, `unbindBot`) (`shell/route.ts:113-135`); `sweepOrphanState` on the tick is the backstop.

### 3g. Session pointer ownership rules
`bot.sessionId` in `shell.json` is the live pointer. Rules to preserve or drop: a late `touchChat`/`setSession` naming a session in `previousSessionIds` is ignored (`shell-store.ts:1067-1081, 1147-1165`); a routine or handoff delivery may rotate the pointer (`agent-exec.ts:945-959, 1038-1055, 1405-1418`) so two writers race on it and the lineage logic exists to serialise them.

### 3h. Admission / workspace stamping (per turn)
- `admissionRefusal` = description over 8000 chars (`shell-store.ts:37`) or envelope > window, 409 with a plain sentence.
- `syncSessionWorkspace` (`agent-exec.ts:228`) writes `{sessionId, path, permission, selection}` into `workspace.json` **before** every turn because the eve agent process resolves tool permission per session from that file. `ensureBotSelections` pins null-model bots when a per-bot pick would otherwise move them (`agent-exec.ts:272`).

---

## 4. Routines and scheduling

Store: `routines.json` (`routines-store.ts`). Routine = `{id, botId, name, instruction(<=4000), schedules[], timezone, active, lastRunAt, runHistory(<=20), manualRunRequested, extra}`.

Trigger path (there is **no timer in the service**; the tick is driven by the app):
```
A   POST /api/agent/tick?limit=2  every few seconds (AppModel.pumpHandoffs :1690)   [also: agent tool run_routine / any tool -> wakePump POST with x-ub-agent-key]
W   pumpRoutines(limit)  -> pumpState.routineQueue (single flight)                   agent-exec.ts:1521
    pumpRoutinesOnce: room = min(limit, 4 - inflight); candidates = pendingRoutines(now) minus inflight;
    one routine per bot; claimManualRun(id) ?? claimDueRoutine(id, now)  (moves anchor inside the store lock; no retry on failure)
    routinesInflight.add; void executeRoutine(...) detached; returns {started, failed, skipped}
W   executeRoutine (agent-exec.ts:1314):
      appendAgentEvent(note "Routine X ran." / "Test run of routine X.")   -> agents.json
      appendAgentEvent(user, routine.instruction)                          -> agents.json
      runEveTurn(bot, instruction, {totalMs: 1 h, idleMs: 10 min}, "routine", [routineLine])
         -> admitFresh, resolve/verify session binding, history ids via stream replay (sessionEventIds), syncSessionWorkspaceFresh,
            POST E session (or create), bindCreatedSession, GET E stream?startIndex=0, readHandoffStream arms on the exact sent text
            ("Scheduled run of the routine X. Nobody is watching: don't ask questions...") and collects text until turn end
      on failure: appendAgentEvent(note "Routine X failed: ...") then rethrow with sessionId attached
      on success: appendAgentEvent(assistant, reply); updateShell(bot.sessionId=<session>, lastPreview, lastAt)
W   .then/.catch -> appendRoutineRun(id, {status ok|failed, sessionId, error})        -> routines.json (history shown in the pane)
```
Delivery of the result to the owner: the routine runs **inside the bot's own live chat session** (`bot.sessionId`, creating one if null), so the follower in the app sees the turn on the normal stream; `agents.json` rows (note/user/assistant) are the durable overlay; `shell.json` preview/pointer are updated; the tick's `workingBotIds` (handoff receivers + bots with a routine running, `agent-exec.ts:1698`) drives the rail pulse and the "reply ready" notification when the id disappears (`AppModel.swift:1700-1720`).

Manual run: `POST /api/routines/<id>/run` -> `startRoutineNow` claims synchronously (`routine_busy`/`routine_missing`/`routines_locked` map to 409/404/503), then `runClaimedRoutine` detached (`agent-exec.ts:1430-1466`). A paused routine still runs from here. An agent-tool run request sets `manualRunRequested`; the next tick picks it up.

Things the spec must decide: (1) routines only fire while the app is running and polling (documented intent: "the owner needs nothing running but the app", `tick/route.ts:103`); (2) the 1 h / 10 min idle budget and the "hidden note" are eve-specific wrappers around a prompt; with Pi it is `session.prompt()` plus `agent_settled`; (3) `sweepOrphanRoutines(live bot ids)` removes routines whose bot left the roster (`agent-exec.ts:1625-1664`, guarded by `peekShell` + `shellWasReseeded`).

Connect-card resume (same tick): `pumpConnects`/`pumpConnections` poll Composio / the MCP OAuth state; on success `queueResume` (`connect-flow.ts:96-148`) writes a **handoff** from the orchestrator to the bot; `pumpHandoffs` later delivers it as a normal turn. This is the only non-multi-bot consumer of the handoff queue.

---

## 5. Approvals

Two separate mechanisms:

1. **Own approval cards** (the one with an HTTP surface). File store `approvals.json` (`UB_APPROVALS_PATH`, `agent/lib/approvals.ts:144`): records `{id apr_*, sessionId, turnId, toolCallId, tool, actionSha256, preview, createdAt, expiresAt(+5 min, POLICY_APPROVAL_TTL_MS), status pending|approved|denied|expired|consumed, epoch, rootSessionId?, subagent?}`; mkdir lock at `<file>.lock`.
   - Tool side (agent process): `request()` writes a pending record, then `waitUntilNotPending` polls the file every 250 ms (`approvals.ts:439-461`) and `consume(id, hash)` once, with replay protection (`approval_replay`) and a boot-epoch check so a restart invalidates granted-but-unused approvals (`:277-308`, `invalidateOnRestart` :381). Gated tools: bash, write_file, memory.upsert/delete, delete_bot, remove_section, clear_history, delete/create/update_routine, connector, connection, install_cli (`ApprovalTool`, :57-71).
   - App side: `GET /api/approvals` (polled ~1.5 s) returns `listPending()` rows with `botId`/`botName` resolved from the session (`approvals/route.ts:23-31`), 503 `approvals_locked` on lock contention; `POST /api/approvals/<id>` decides with `{decision, actionSha256}` (hash must match, timing-safe) -> `ApprovalStore.decide` (`[id]/route.ts:35-39`). Errors: `approval_not_found` 404, `approval_not_pending:*`, `approval_hash_mismatch` 400.
   - Cancel interplay: `expireSession` on cancel / on `session_not_active` (section 3).
2. **eve input requests** (`input.requested` / `input.resolved` events; session-limit prompts and similar). Answered through the session POST with `inputResponses`, never through `/api/approvals`.

For Pi: pi's `tool_call` extension event can block or mutate a call and `ctx.ui.confirm` is the documented pattern (`extensions.md` lines ~279-295, "Confirm or block tool calls"). In an in-process host, a `tool_call` handler could call the same `ApprovalStore.request` and await `waitUntilNotPending`; the HTTP routes, the 5-minute TTL, the hash binding and the card UI would not need to change. `rootSessionId`/`subagent` fields and the `resolveSessionBot` lookup go away.

---

## 6. Transcript

### 6a. Where the visible transcript comes from today
Chat turns exist **only in the eve session event log** (`ChatSnapshot.swift:6`: "Chat turns live only in the eve session"). The app builds the chat by replaying `GET /eve/v1/session/<id>/stream` into its Swift `StreamProjection` and **merges** a second source, the durable overlay `agents.json` thread events (via `GET /api/agent/state`), for rows eve never sees: notes (routine ran/failed, connected, confirmed), widgets, images, pages, proposals and handoff rows. `EVENT_CAP_PER_THREAD=300` (`agent-store.ts:27`), so the overlay is a bounded side channel, not a transcript.

eve events the Swift app consumes (case labels in `EveStream.swift`): `turn.started` :1807, `message.received` :1860, `compaction.requested/completed` :2030/2034, `actions.requested` :2050, `action.input.appended` :2082, `message.appended` :2090, `message.completed` :2149, `turn.failed`/`session.failed` :2202, `action.result`/`action.partial` :2277, `subagent.completed`/`subagent.called` :2298/2308, `step.started` :2321, `input.requested`/`input.resolved` :2326/2369, `turn.completed`/`turn.cancelled`/`session.waiting`/`session.completed` :2391. Fields used by server-side code: `data.message`, `data.messageDelta`, `meta.id`, `data.turnId`, `data.actions[].{callId,toolName,input}`, `data.result.{callId,output}`, `data.status`.

### 6b. Wire contract the app depends on (what a Pi-backed stream must reproduce, or the Swift side changes)
- Absolute event index: `startIndex=N` begins at event N; every yielded event gets its own `index`; the app keeps `index+1` as a cursor (`BackendClient.swift:2202-2206`).
- Tail: `includeTailIndex=1` -> response header `x-eve-stream-tail-index` = index of the last durable event (-1 empty); the proxy forwards it (`route.ts:519-523`). `HistorySnapshot.nextIndex = tail+1` (`BackendClient.swift:2107`).
- Negative `startIndex` = relative to tail (`startIndex=-1` for the newest event id; `tailCount`) (`BackendClient.swift:2141-2170, 2292`).
- The stream stays open after the last event (follow mode); catch-up reads end at the tail; otherwise a quiet period ends them.
- Events carry `meta.id` and `data.turnId`; the app arms a send on the first turn id not in the pre-send set (`historyTurnIds`) and on the message text.
- Replay is idempotent by `meta.id` (`eve-stream.ts:129-130`).

### 6c. Snapshots, cursor resume, replay, startIndex probe (all app side)
- `ChatSnapshot` (`ChatSnapshot.swift`, `formatVersion = 11`): `{botId, sessionId, cursor, lastEventId, projection, durableEvents, seenTurnIds, localTurnIds, savedAt, build}`; one file per bot under `~/Library/Caches/UsefulBot/chat-snapshots` (dev variant has its own dir), max age 7 d, invalid on `build` mismatch (hash of fold logic) or session change. Written only for a chat at rest.
- Resume = apply events `cursor...` to the stored projection. If the newest event id on the server equals `lastEventId`, nothing is read: that probe is `newestEventId` = `startIndex=-1`, 0.8 s timeout (`BackendClient.swift:2146-2210`). The comment explains why not `includeTailIndex`: eve opens every chunk file (1.25 s on 12 554 events).
- Full replay is the fallback and the only read that sees where a turn in flight began.
- Server side carries no snapshot logic; only the 48 MB / 20 000-event carry-over reader (3d).

### 6d. What Pi's JSONL gives and does not give (docs: `session-format.md`, `json.md`, `sdk.md`)
- One file per session: `~/.pi/agent/sessions/--<cwd path>--/<timestamp>_<id>.jsonl` (override with `sessionDir`); custom session id supported at create. Line 1 is a header (not an entry). Later lines are tree entries `{type,id,parentId,timestamp}`: `message` (user, assistant, toolResult, system), `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message` (participates in context; `display:false` hides it), `label`, `session_info`.
- Persisted entries are **finalized messages**. Streaming `message_update` deltas appear only on the live event feed (`JsonAgentSessionEvent`; SDK `session.subscribe`), not in the file.
- Live events: `agent_start/end`, `agent_settled`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `queue_update`, `compaction_start/end`, `auto_retry_*`, `thinking_level_changed`, `session_info_changed`, `entry_appended` (json.md).
- No absolute event counter or tail header: a Pi-backed server must define an index (for example JSONL line number, or a counter over a normalised event list) and serve `startIndex` and `x-eve-stream-tail-index` itself, or the Swift cursor/snapshot design changes. Entry ids are 8-hex, not counters. Non-message entries and compaction/branching change what "the transcript" is (tree + active leaf; compaction replaces earlier entries in model context only).
- No `turnId` in the file; `agent_start`/`turn_start` carry none. The app's turn arming needs an id the server mints.
- `prompt()` during a run requires `steer()` or `followUp()` (sdk.md "Prompting"); eve's channel currently queues sends (`agent/channels/eve.ts: turnPolicy "queue"`).
- Hidden app notes (carry-over brief, retry note, routine line) map naturally to `custom_message` entries instead of a text prefix that the transcript must strip (`SESSION_NOTE_LEAD`, `stripThreadPrefix`).
- The overlay (`agents.json`) could stay as is, or its rows could become `custom` entries; either way `ChatSnapshot.durableEvents` and `/api/agent/state` are tied to it.
- Token/usage: assistant messages and `usage` entries carry usage; the `/api/usage` meter today reads the router's sqlite instead.

---

## 7. Auth between app and service

Layers, in request order:

1. **Ingress class** (`web/lib/ingress.ts`): `loopback` | `tailnet` | `unknown`; unknown always refused. Next synthesises x-forwarded-* on loopback, handled by `onlyLoopbackEcho` (:78). `tailnet` requires the enrolled `tailscale-user-login`, https proto and a first XFF hop in 100.64/10 or fd7a:115c:a1e0::/48 (:171-195). Config comes from the router's `config.json` (`web/lib/runtime-config.ts`, cached on mtime+size).
2. **Session cookie** `ub_session` (HttpOnly, SameSite=Strict, 12 h; `Secure` only on tailnet) (`web/lib/auth.ts:10-70`). Server record in `web-sessions.json`. A credential-bound session dies with its credential row (`credentialById`, `desktop-gate.ts:38-42`). Phone sessions die with `phoneEnabled=false` (:43).
3. **Session mint**: the macOS app does `POST /api/auth/session` with `Authorization: Bearer <device token>` read from the Keychain (`DeviceTokenStore.swift`, `BackendClient.swift:435-470`); the server compares sha256 to `credentials[].sha256` (kind device|router, expiry, revoke) in the router config (`auth.ts:21-33`). Response carries `csrfToken`; the app attaches the cookie manually and re-signs-in once on 401/403 (`reauth`, :638).
4. **CSRF**: `x-ub-csrf` must equal `session.csrf` on every non-GET handler (repeated inline in each route; no shared helper). `/api/agent/tick` additionally allows a keyed caller.
5. **Origin**: `originAllowed` (`ingress.ts:202`): absent Origin passes; a present one must be loopback (or the tailnet origin on tailnet ingress).
6. **Rate limit**: in-process token buckets keyed `<scope>:<callerId>` (`api-guard.ts:156`), idle sweep; single-process only. Per-route limits are in each file (eve 60/min for writes, tick 120/min, approvals GET 240, POST 120, shell 120, routines 60, regenerate 6).
7. **Body caps**: JSON 256 KB, eve proxy 8 MB, attachments 1 MB + 64 KB, widget call 2 MB (`api-guard.ts:8-13`, `attachments.ts:1`, `widget/[id]/call/route.ts:11`).
8. **Web -> eve channel JWT**: HS256, `iss/aud: useful-bot`, `sub: desktop-app`, claims `botId` (string, because eve projects only string claims) and `delivery` (`owner|handoff|routine`), 12 h, cached per (bot, delivery) and re-signed within 1 h of expiry (`agent-exec.ts:380-434`). Secret `UB_CHANNEL_JWT_SECRET` read from Keychain item `channel.desktop` by `scripts/service.mjs:215`. A no-bot token exists only for health, info and cancel of an unbound session (`channelJwtNoBot`).
9. **eve-side enforcement** (`agent/lib/channel-auth.ts`, `agent/lib/session-owners.ts`): a create needs a `botId` claim on the roster; any call on a session needs claim == bound bot; unbound session refused except cancel; first principal to claim a session in `policy.sqlite` (`owners` table) owns it (`SessionOwners.claim`).
10. **Agent -> web**: `UB_CHANNEL_JWT` (pre-signed, no bot claim, `service.mjs:243`) is the `x-ub-agent-key` for `/api/agent/tick`; `UB_WEB_BASE_URL` tells the agent where to POST (`agents-send.ts:136-141`).

What Pi changes: layers 8, 9 and the agent->web key (10) exist only because eve is a separate HTTP service holding per-bot sessions; an in-process engine needs none of them. Layers 1-7 stay as they are. The device-credential store (layer 3) physically lives in the router's `config.json`; if the router is retired, `runtime.ts`/`runtime-config.ts` need a new home for it. Phone/tailnet code (ingress tailnet branch, `phoneDisabled`, `tailnet` callback URLs in `shell/route.ts:143-153`, `connections/route.ts:35`) is scaffolding for the unbuilt iPhone app (AGENTS.md "Mobile app. Planned, not built yet"); not engine- or bot-specific: UNSURE whether to keep.

Process-model constraints that follow from the code (relevant to hosting Pi in `web/`):
- Next dev gives each route its own module copy; shared in-memory state is therefore pinned on `globalThis` symbols (`agent-exec.ts:354-366`, `sync-models.ts:22-27`, `image-regenerate.ts:19-24`). An in-process Pi session registry must do the same.
- The web service is launched by the app's supervisor as `service.mjs` (next standalone), separate from eve; eve's port 4321 and `com.usefulbot.eve` launchd label (`launchd-render.ts:6`) are part of the service set the Swift `ServiceSupervisor` starts and health-checks.

---

## 8. Multi-bot surface

"Bots" are roster rows in `shell.json`; groups are bots with `kind:"group"`; the Generalist `bot-useful` is the orchestrator. Line counts are approximate (grep + read); "whole" = the file exists for this concept.

| Concept | Where (file:line) | Size | Notes |
|---|---|---|---|
| Roster, sections, pin/hide, selection, recents | `shared/shell-store.ts`: types :41-160, reducer cases createBot :833, createSection :911, nameBot :921, renameBot/Section :942-961, updateBot :962, pin :1004, hide :1016, deleteBot :1027, deleteSection :1042, move :1053, select :829, toggleSection :1231; helpers `selectedBot..searchShell` :1286-1365 | ~600 of 1365 | With 1-2 bots: keep one profile record + settings; sections/pin/hide/recents-of-many/search vanish |
| Groups | `shell-store.ts` createGroup :873, `normalizeMembers` :781, `GROUP_*` :31-32; `threads.ts` (whole, 214); `context-blocks.ts` `renderYourGroup` :87; `admission.ts` contextText group branch :113-128; `eve-proxy.ts` `eveSessionRoute`, `mentionLine`, `SessionRoute` :253-291; `agent-exec.ts` `receiverOf` :759; `shell/route.ts` fan-out recipients :304-318, `applyFollowUp` :47-70 | ~450 | Untargeted group turns are answered by the orchestrator (`threads.ts:27,201`) |
| Handoffs (bot->bot messages, depth max 3, claim/lease queue) | `shared/handoffs.ts` (419); `shared/agents-send.ts` (148); `agent-exec.ts` :63-95 consts, :741-766 envelope/receiver, :1011-1076 deliver/inflight, :1078-1178 pump, :1180-1249 `fanOut`/`deliverFirstBrief`; tick route `pumpHandoffs` :102; Swift parses the handoff envelope (comment `agent-exec.ts:749`) | ~850 | `readHandoffStream` (:447) and `runEveTurn` (:815) are shared with routines and carry-over |
| Cross-bot send | `agent/tools/send_to_bot.ts`, `post_to_group.ts`, `list_bots.ts` (agent side, not mine); shell action `sendToBot` :1123; proposal `fanout`; `shared/agent-store.ts` event kinds `handoff`/`post`, `ReserveKind handoff/post` | ~80 in shared | Note `sendToBot` also nulls the target's `sessionId` (:1131) |
| Proposals for new bots, groups, profile edits, fan-out | `agent-store.ts` types :87-139, `createProposal` :729, `createProfileProposalOnce` :756, `nextPetname` :785, `claimProposal` :798; `shell-store.ts` `proposerMayConfirm`/`orchestratorId`/`profileCardIsCurrent` :742-780; `shell/route.ts` `proposalMatchesAction` :155-200, claim/replay logic :350-408, `noteProposal` :203-224, first-brief :491-509; `profileRevision` field | ~330 in route, ~250 in agent-store, ~40 in shell-store | `connectApp`/`connectServer` proposals (:141-192) are **not** multi-bot: keep that machinery |
| Orchestrator authority | `orchestratorId` `shell-store.ts:770`; used by `threads.ts`, `context-blocks`, `admission`, `connect-flow.ts:101-106`, `connection-flow.ts` | small | The Generalist also "creates other bots" per its seed text (`shell-store.ts:255-262`) |
| Generalist seed and overlay | `GENERALIST_SEEDS`, `GENERALIST_SEED_V2`, `overlaySeed` `shell-store.ts:255-292`; `admission.ts:161-165 seedFor`; `/api/bots/context` | ~80 | Seed text mentions building a team of bots |
| Bot face / avatar / petname | `shared/bot-face.ts` (68); `shell-store.ts` avatar* fields + parsers (47 mentions), `petname`; `agent-store.ts` BotProfileDraft; Swift `BotFaceGeometry.swift` etc. (not mine) | ~150 in shared | `bot-face.ts:3`: "Clients render only the mascot" |
| Session -> bot binding and ownership | `shared/session-bindings.ts` (375); `web/lib/eve-session-auth.ts` `authorizeEveCall`/`carryOverReader` :29-73; `agent/lib/channel-auth.ts`, `session-owners.ts` (eve side) | ~450 | Needed in some form if 2 bots share a service |
| Sub-agents | `web/lib/eve-session-auth.ts` :75-277 (child stream/cancel verification via the parent's `subagent.called` event at absolute index `at`); `eve-proxy.ts` :196-241; `shared/subagent-stops.ts` (50); `session-bindings.ts` `bindChildSession` :195-227, `parentId`; `approvals/route.ts` `rootSessionId`/`subagent` :26-30; `ApprovalStore.expireSession children` ; `route.ts` :116-144, 162-190, 469-486; `admission.ts` prompt constants include `agent`/`task_cancel` tool sizes (:22-36); Swift `SubagentRuns.swift`, `SubagentCard.swift` (not mine) | ~450 | Whole sub-agent verification chain is one concept |
| Per-bot model selection | `session-selection.ts` (150); `shell-store.ts` `bot.model`, `freezeNullSelections` :1256, `clearConnectionSelections` :1269, `withBotSelection` :1278; `providers.ts` `applyBotPick`, `botComposerState`, `effectiveDefault`; `web/lib/providers-write.ts` per-bot branch :118-216; `agent-exec.ts` `ensureBotSelections` :272 | ~300 | With 1-2 bots it remains useful, but the "null inherits last pick, pin on first per-bot pick" logic only matters with many bots |
| Per-bot workspace/permission | `bot.workspace`, `bot.permission` in `shell-store.ts`; actions setWorkspace :1085, setPermission :1106; `staleSessionIds` :544; route revoke/restamp `shell/route.ts:434-479`; `workspace-store.ts` grants | ~250 | Stays per bot (or per app) |
| Per-bot data keyed by botId (not removable, but keys change) | routines (`routines.json` `botId`, `ROUTINES_PER_BOT_MAX`), memory (`agent/lib/memory.ts` + `/api/memory?botId`), media (`botId`, `botName` in index), `agents.json` thread id = botId, widget events, `session-owners.json` | n/a | |
| Roster-driven maintenance | `sweepOrphanState` `agent-exec.ts:1625-1683` (orphan routines/threads/widgets), `peekShell` + `shellWasReseeded` reseed guard in `shell-io.ts:23-137`, `detachBot` `shell/route.ts:113` | ~200 | The reseed marker exists to stop a recovery stub from looking like a roster that deleted everyone else's data |
| Rail "working" pulses | `backgroundWorkingBotIds`, `handoffWorkingBotIds` `agent-exec.ts:1065, 1698`, tick `workingBotIds` | ~40 | Swift consumes `workingBotIds` |
| Dead/orphan | `x-ub-route` response header: produced at `route.ts:595-598`, parsed only in `test/multi-agent.test.ts`; no Swift reader (grep of `macos/Sources` empty) | ~30 | `parseSessionRouteHeader` has no production caller |

Agent-side tools that implement the multi-bot features (outside this brief but they write the same stores): `agent/tools/{list_bots,send_to_bot,post_to_group,propose_bot,propose_group,update_bot_profile,delete_bot,rail_action,clear_history}.ts`.

---

## 9. Cross-cutting facts for the spec

- Every `shared/` store has two writers (web + eve agent process). Moving the engine in-process removes the second writer for: `workspace.json` grants, `session-owners.json`, `approvals.json` (still cross-process only if tools stay out of process), `subagent-stops.json`, `connection-tools.json` per-session picks, `agents.json`. Locking code can then simplify, but is copy-pasted ~7 times today (fixed 8 s/3 s constants).
- The engine call sites in `web/` are exactly: `eve/v1/[...path]/route.ts:493` (+ its pre-reads), `agent-exec.ts` (`runEveTurn` :891/927/968/984, `sessionEventIds` :556, `readStreamRange` :621, `cancelEveTurn` :793), `eve-session-auth.ts:127` (`readStreamEventAt`), `status/route.ts:12`. Nothing else in `web/` or `shared/` imports `eve` as a package (grep `from "eve` in web/shared: none); `agent/` does (`defineAgent`, `defineTool`, `eveChannel`).
- The only `shared/` code that parses eve event shapes: `eve-stream.ts`, `continuation-brief.ts` (`message.*`, `actions.requested`, `action.result`, `turn.failed`, `step.completed`), `mcp-apps.ts`, `agent-exec.ts readHandoffStream`.
- Router coupling (decide router fate first): `session-selection.ts` header, `policy.ts`, `contracts.ts`, `limits-store.ts`, `usage-parse.ts`, `inline-think.ts`, `registry.json`, `/api/usage`, `/api/reviewer`, `lib/image-regenerate.ts` (calls `routerOrigin()`), `live-models.ts`/`providers.ts` `resolveUpstream`, `runtime.ts` (credential digests). `tool-wire-size.ts` and `MAX_TOOL_SCHEMA_BYTES` exist to stay under the router's 128 KB tool-array refusal (`policy.ts:122`).
- Test suite wiring: `package.json` `test` script lists ~100 files; eve/bot specific ones include `eve-proxy-guard`, `session-binding`, `channel-auth`, `session-owners`, `cross-bot`, `multi-agent`, `handoff-stream`, `first-brief`, `continuation-brief`, `eve-stream`, `agents`, `admission`, `envelopes`, `turn-snapshot`, `session-store`.

---

## 10. Quick classification summary

REMOVE-EVE: `shared/eve-proxy.ts` (keep validators), `shared/eve-stream.ts`, `shared/continuation-brief.ts` (keep notes idea), `web/app/eve/v1/[...path]/route.ts`, `web/lib/eve-session-auth.ts` (the channel-JWT half), `web/lib/agent-exec.ts` engine calls (`runEveTurn`, `readHandoffStream`, `sessionEventIds`, `readStreamRange`, `cancelEveTurn`, `channelJwt*`), `/api/status` eve probe, `scripts/service.mjs eve` mode.

REMOVE-MULTIBOT: `shared/handoffs.ts`, `shared/agents-send.ts`, `shared/threads.ts` (except legacy prefix strip), `shared/subagent-stops.ts`, `shared/bot-face.ts`, the group/section/pin/hide/proposal parts of `shell-store.ts` and `shell/route.ts`, `agent-store.ts` bot/group/profile/fanout proposals, `session-bindings.ts` child + backfill logic, the child-stream verification in `eve-session-auth.ts`, `pumpHandoffs`/`fanOut`/`deliverFirstBrief` in `agent-exec.ts`, `x-ub-route`.

ADAPT: `/api/shell`, `/api/agent/state`, `/api/agent/tick`, `/api/status`, `/api/approvals` GET, `/api/routines*`, `/api/providers`, `/api/bots/context`, `/api/agent/widget`, `admission.ts`, `context-blocks.ts`, `session-selection.ts`, `workspace-store.ts`, `agent-store.ts`, `providers.ts`, `connection-tools*.ts`.

KEEP: auth stack (`auth/session`, `web-sessions`, `ingress`, `desktop-gate`, `api-guard`, `origin`, `runtime`), `/api/attachments`, `/api/memory`, `/api/workspace`, media/image/widget routes, connections + connectors routes and stores, `routines-store.ts`, `stack.ts`, `keychain.ts`, `dir-lock.ts`.

UNSURE: `/api/usage`, `/api/reviewer` (no macOS caller), router-coupled modules (`policy.ts`, `contracts.ts`, `limits-store.ts`, `usage-parse.ts`, `inline-think.ts`, `registry.json`, `live-models.ts`, `provider-catalog.ts`, `models.ts`), phone/tailnet scaffolding, auto-mint branch of GET `/api/auth/session`, chatgpt sign-in vs Pi login.
