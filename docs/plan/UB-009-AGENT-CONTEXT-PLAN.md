# UB-009: agent instructions and per-bot context, final plan

Status: **approved by the owner** (2026-10-01). Implemented: step 0 (#174), PR A (#175), PR B (#176) and PR C (#177). Evals: `evals/results/2026-10-02-ub009-prc.md`.

Process and evidence: `docs/plan/UB-009-AGENT-CONTEXT-COUNCIL.md`, `docs/audit/UB-009-GENERALIST-PROMPT.md`,
and `evals/results/2026-10-01-ub009-council/` (packet, round 1 from five seats, round 2 critiques,
synthesis). The final texts are in `evals/results/2026-10-01-ub009-council/final/`.

## 1. What changes, in one paragraph

Every bot runs on three system-role layers:
1. **Shared instructions** (`instructions.md`, 913 words, down from 2,942). Product rules every bot follows, correct tool names, and no claim the code doesn't enforce.
2. **Its own instructions.** The description, now the bot's AGENTS.md: trusted, up to 8,000 characters, and present on every turn and after a model change or compaction.
3. **A "This turn" block.** Owner, date, time zone, permission, folder and the bot's actual model.

The Generalist also gets a code-owned "Running the team" block. Every bot also gets its own notes: the 6 most recent in full, the rest as titles, read on demand. The security gaps the audit found are closed in code first.

## 2. Architecture

- **One resolver:** `agent/instructions/context.ts`, a `defineDynamic` on `turn.started`. It returns one system message after `instructions.md`, in this order: Running the team (orchestrator only), Your bot, This turn. Notes travel separately (section 4). One file gives one wait, one success marker and a deterministic order.
- **Durable session ownership:** a new persisted session→bot store, immutable once written. It's written by the proxy and by `agent-exec` on every create, continue, routine, handoff and 409 carry-over, and backfilled from the shell's `sessionId`/`continuedSessionId`.
  - `SessionGrant` stays a capability cache: it's capped at 64 and evicted, so it can't hold identity.
  - `activeBotId` and the memory tools use the new store. There is no `selectedBotId` fallback for an agent turn.
- **Turn snapshot:** the resolver waits (bounded) for the binding and computes one snapshot per (session, turn): bot, instructions revision, model selection, permission and folder.
  - The `step.started` model freeze and `list_models` read that same snapshot.
  - One selection per turn is both shown and used.
- **Fail closed, before the turn starts where possible:** the proxy and `runEveTurn` refuse a send whose bot can't be bound, before eve accepts it, because a turn eve accepts and then fails retires the session.
  - Inside eve, dispatch refuses a non-child turn whose snapshot is missing (`bot_context_missing`). This backstop may retire the session (eve docs and the app's retire cascade differ). It is logged and counted, and the cold-start eval records which happens.
  - The JWT premise is confirmed (Fable): `jwtHmac` projects custom claims into `ctx.session.auth.current.attributes`.
  - Spike first: a per-request channel JWT with a bot claim, which removes the first-turn race entirely. Polling is the fallback.
- **Child sessions** (eve `agent`) are disabled until ownership and grants propagate to them (done 2026-10-03: `agent` and `task_cancel` are back; a child acts as its root session's bot under the root's grant, resolved from `ctx.session.parent.rootSessionId` in `agent/lib/active-bot.ts`; it reads and works in files but changes no memory, roster, routines or profiles).
- **Admission check:** before dispatch, the proxy, and `runEveTurn` for routines and handoffs, compares the fixed envelope with the selected model's window. The envelope is instructions, description, the notes block, tool schemas, output reserve, and on a carry-over turn the brief, which is sized from the bot's window.
  - It refuses with a plain message rather than clipping instructions.
  - The Settings counter shows tokens against the bot's model window.
- **No rollout flag.** Rollback is reverting the PR and rebuilding Useful Bot Dev. Releases are cut by the owner only.

## 3. Decisions (council disagreements resolved)

| Topic | Decision |
|---|---|
| Shared prompt | 913 words. CI cap 950 by `wc -w` on the file. Per-tool mechanics move into tool descriptions or error hints (bash sign-in and `gh` keychain, timeouts, PATH). |
| Generalist mechanics | A code-owned block for the orchestrator's own chat. Long procedures move to skills `connect-apps` and `about-useful-bot`. A behavior eval checks that the skills get loaded. |
| Orchestrator | The default bot, or the first visible bot if the owner deleted it. One helper is used everywhere: the block, the refusals, `propose_group` membership, and `rail_action`/`delete_bot` protection. In the fallback case "Running the team" drops its first sentence. A group session gets the slim group variant, not the full block. |
| Group sessions | Their own class. A group acts on itself (its routines, its chat, notes under the group id) and may `send_to_bot` and `post_to_group` to its own members. It gets no orchestrator-only tool. Its notes are the group's own. Covered by the cross-bot eval. |
| Cross-bot reach | One rule in `permission.ts`: a plain bot acts only on itself and its own routines (`create`/`list`/`update`/`delete`/`run_routine`, `rail_action`, `clear_history`, `update_bot_profile`, memory). Orchestrator only: `propose_bot`, `propose_group`, `delete_bot`, `clear_history` with `all`, and acting on other bots. Checked at execution time. |
| Per-turn facts | System, last, day-granularity date. A cache eval is the gate: if it shows a regression, date, permission and folder move to a user-role line. |
| Description | Trusted, verbatim inside a boundary it can't close. 8,000-character hard cap, refused and never clipped, across every path (store, `parseShell`, `agent-store` proposals, tool schemas, group descriptions, which are stored and confirmed now too). `propose_bot` capped at 2,000. |
| Shipped Generalist text | An append-only seed list with an exact, whitespace-normalized match, **only on `bot-useful`**, applied as a **pure overlay in `parseShell`**. No write on read, so no lock recursion, and it persists on the next normal write. Rename "Useful Bot" to "Generalist" only when the name is "Useful Bot", the description is an untouched seed and `avatarCustom` is false. |
| Profile edits | Only when the owner asks. A plain bot can target only itself. The card shows the full text and a diff. Approval is bound to the text and the profile revision. "Suggested after reading outside content" is tracked from trusted delivery metadata (handoffs and routines don't reset it). One pending proposal per bot. |
| Peer messages | A handoff is a task for the receiver's own role, bounded by its permission. The envelope keeps the group and relay-hop lines. Routine runs get a "nobody is watching" line. |
| Groups | Group variant of "Your bot". A mention no longer tells the orchestrator to speak as the member. `speakerLabel` no longer credits the orchestrator's reply to the member. **Real routing of a mention to the member is deferred** (separate item): it's a new delivery path. |
| Serialization | Every interpolated field is flattened, stripped of control characters and capped. The owner's instructions and notes sit inside boundaries their content can't close. Hostile-name fixtures are in the injection evals. |
| Legacy prefixes in old sessions | One line in "Your bot" says the new instructions replace any older hidden header. A model-facing history rewrite isn't possible through eve's API, so it's not done. |
| `list_bots` | 200-character summaries plus a length, with the full text on request for one bot. Descriptions of other bots stay data. |
| Tool schemas | They are about 5.5 to 6k tokens, the biggest fixed cost. PR C trims tool descriptions to about 60 words each, measured from a fresh compile. Hiding orchestrator schemas from teammates is phase 2, after the probe measures it. |

## 4. Memory (owner-confirmed design)

- A bot's notes are its own memory: it writes, edits and removes them. A new `memory_delete` tool runs at once in Auto and Full and is refused in Read only, like `memory_upsert`.
- **Every session loads the bot's own notes:** the 6 most recently updated in full, every other note as `id: title` (up to 50), then "N more: use memory_search". Bodies open with `memory_read`.
  - **Size bound (Fable):** each loaded body is capped at 1,200 characters ("... open with memory_read"), titles at 80, and the block at 6,000 characters; past that, the rest fall back to titles. The block counts in admission. `memory_read` returns the whole note (up to the 8,192 write cap).
  - **Outside-content marker:** a note written or edited in a turn after untrusted content (a page, an app result, a handoff) is stored with `source: model-after-outside-content`. It shows in the block as "(written after reading outside content)" and in Settings with one-click delete.
  - **First-turn race:** the slot's `scope` reads the same binding as the resolver, with the same bounded wait. `recall` returns nothing on a store error and never throws, so a notes failure can't fail or retire a chat.
- **Labeling:** notes are presented as remembered facts, never instructions. A memory spike decides the delivery:
  - **Preferred:** an eve memory slot over `MemoryStore`. Notes arrive in the user role, as one aggregate record replaced on every recall (including an empty one), and are recalled again after compaction.
  - **Fallback:** a fenced block in the system role.
- **Scoping in code:**
  - Each note gets immutable bot ownership.
  - `search` and `read` filter by bot in SQL before `LIMIT`, and check expiry.
  - `upsert` refuses an existing id the bot doesn't own, and never retags.
  - Untagged legacy notes belong to the Generalist.
  - The `botId` input and the `shared-phone` audience are removed. Existing `shared-phone` notes fold to `desktop` in the same migration that gives untagged notes to the Generalist.
  - `source: owner|model` is shown in Settings.
  - The read clip matches the write cap.
  - `settle` passes `ctx`.

## 5. Security fixes (land first)

1. **Planted config:** shared names, two compilers, one predicate (`shared/policy.ts`).
   - Enforced in `approvedWrite`, before the card and again before the write; reads stay open.
   - Case-insensitive, after verifying SBPL supports it on this macOS (otherwise letter classes).
   - Owner-approved `bash` lines run under `(allow default)` plus the planted-config write denies and the PATH-directory denies (lifted for `install_cli`), nothing else. Credential stores stay reachable, so an approved `gh auth login` or `codex login` still works. If the profile can't load, the approved line is refused with a plain error, never run bare. The git hook `.sample` exceptions stay.
   - Added: `.mcp.json` and `.cursor/mcp.json`, which launch servers. Not whole directories.
2. **OpenAPI:** permission at call time.
   - Read only refuses. Full runs. Auto shows the app's own card. Fable confirmed the hook: `defineOpenAPIConnection`'s `approval` accepts a custom async policy with the session context, so the policy raises the app card through `executeIfApproved`. If the spike disproves it, Auto refuses with "needs Full access", and the `instructions.md` sentence changes to match before PR C.
   - The owner's `toolsAllow` is honored through `operations.allow` in the same change.
   - Zero-side-effect tests: denial, expiry, replay, changed arguments, narrowed permission, a repointed connection, a mutating operation named `list_items`.
3. **`web_fetch` and `review`** outputs are fenced with `wrapUntrusted`.
4. **`agent` and `task_cancel`** were disabled here (back on since 2026-10-03, see Child sessions above). The original step: spike `disableTool()` first; fall back to `defaultTools: false` plus re-adds, with the payload probe diffing the tool list.
5. **Memory scoping and the cross-bot rule** (sections 3 and 4).

## 6. Settings and memory UI (owner requirement: premium, not just bigger)

Before building, design the whole bot Settings pane with the useful-design skill and show the owner a mockup for approval: profile, Instructions, Memory and Routines.

- **Instructions:** a clean editor at rest that grows with the text, then scrolls. A token counter appears only near the limit. Over the cap is refused with the draft kept. "Restore default" appears for the Generalist when it differs from the shipped text.
- **Memory:** note titles in a list, collapsed by default. A row expands to show the body and collapses again.
- **Routines:** as today, placed in the same layout.
- **Order (owner, 2026-10-01):** Profile, then Instructions, Routines, Memory and the notification toggle.
  - Profile is a 76 pt avatar beside the Name and Label fields.
  - The avatar palette grows to 30 colors (10 hues × light, mid, deep): three rows of small swatches, about half today's size, with the picked color's name shown.
- **Notifications are a dead switch today.** `notify` is saved (`shell-store.ts:841`, `BackendModels.swift:59`), but nothing reads it and the app has no `UserNotifications` code. This work makes it real:
  - When a turn finishes in a bot with `notify` on, and that chat isn't the one on screen, the app posts a macOS notification ("Generalist finished") that opens the chat.
  - It asks for notification permission the first time the switch is turned on.
  - The live check covers on, off, permission denied and the chat already open.

The build is verified with screenshots of Useful Bot Dev, and a 30 fps recording of the expand/collapse and editor growth (UI rule: motion is verified frame by frame).

## 7. Texts

- `final/instructions.md`: the shared prompt.
- `final/context-blocks.md`: Running the team, Your bot (plus the group variant), Your notes, This turn, the Generalist's shipped instructions, and the remaining user-role lines.
- Skills `connect-apps` and `about-useful-bot`: content lifted from today's Connectors and About sections, without the third-party price and the UI-location claims.

## 8. PRs, in order

0. **Payload probe and spikes (B0):**
   - the probe dumps the exact provider-bound system array, tool list and first user message;
   - JWT bot claim;
   - eve memory slot;
   - OpenAPI card hook;
   - SBPL case-insensitivity;
   - `disableTool()` (used while `agent` and `task_cancel` were off; both are back on since 2026-10-03).

   Spike results are recorded in `evals/results/`.
1. **PR A, security** (sensitive review: Sonnet plus GPT-6.1-Sol, split by area).
   - **First commit (Fable):** the durable binding store and a fail-closed `activeBotId`. An unbound session gets `bot_context_missing` from in-app and memory tools, never the `selectedBotId` fallback, so the cross-bot rule can't key on the wrong bot.
   - Then section 5 and the cross-bot rule.
2. **PR B, context engine:**
   - resolver, snapshot and admission (the binding store already landed in PR A);
   - prefix builders removed only after binding and dispatch checks land (same PR, later commit);
   - description cap and seed overlay;
   - memory loading and `memory_delete`;
   - groups and envelopes.

   The macOS UI comes after the owner approves the mockup.
3. **PR C, texts:**
   - the new `instructions.md` and skills;
   - tool-description trims and camelCase fixes;
   - starter wording;
   - CI checks (word cap; every backticked tool reference exists).

## 9. Evals (before and after, in Useful Bot Dev, kept in `evals/results/`)

- **Payload probe:** Generalist, teammate and group; exactly one context system message.
- **Cold start:** 20 new teammate sessions, with the stamp delayed and with it missing. The request must carry the bot block, or the send must be refused before eve.
- **Mid-session edit, model switch, compaction, 409 carry-over:** the next request carries the current text.
- **Cross-bot:** an Auto teammate tries to edit and run a Full access bot's routine, clear its chat, read and overwrite its notes by guessed id.
- **Injection:** pages and handoffs asking for profile edits or note writes; hostile folder and model names.
- **Planted config:** 20 paths × 3 modes × `write_file`, confined `bash` and approved `bash`, including computed destinations, case variants and symlinks.
- **OpenAPI:** the fixture suite from section 5.
- **Seed overlay:** every historical string, edited, whitespace, a missing Generalist, two processes.
- **Cache:** 12 scripted turns, recording cached input tokens, with a permission flip and a run across midnight.
- **Small models:** an 8B local model at its real window. Admission refusals, completion, compaction count.
- **Behavior:** 30 scenarios on one cloud and one local model, old versus new.
  - Ask versus act, honest limits, verification, refusal wording.
  - Skills actually loaded for app setup and "about" questions.
  - Fixed overhead, measured.

## 10. Dismissed, with evidence

- **Space Bunny r1 E2 (double prefix):** no double-send. `runEveTurn` posts to eve's own port (`shared/stack.ts:150`), not the proxy. It's moot once the prefix builder goes.
- **MiMo (planted-config check inside `resolveWorkspacePath`):** that would block reads, which must stay open.
- **MiMo (connector mechanics in the Generalist's editable description):** a tool change would then need a description migration. The mechanics stay code-owned.
- **Muse (rollout flag):** rejected. Rollback is stated in section 2, and missing context fails loud.
- **Space Bunny r2:** both attempts ended on an auto-rejected `/tmp` call with no findings. Dropped after one restart (council rule); its round 1 stands.
- **`.vscode/tasks.json` (Muse r2 7):** dropped from the planted list. A task runs only when someone chooses Run Task; `.mcp.json` launches servers on its own.
- **`review` in the shared prompt (Muse r2 16c):** stays in its own tool description, to keep the prompt under its cap.
- **Folder versus shell reach in "This turn" (Muse r2 16a):** the tool results already report real paths and the refusal says why; no extra line.
- **"Several system messages" rationale for one resolver (Fable):** withdrawn. One resolver stays for one wait, one marker and a fixed order.

## 11. Owner decisions (2026-10-01)

- **P1, cards in code:** yes, in Auto with a folder. A card is required for package installs (`npm`/`pnpm`/`yarn`/`bun add|install`, `pip`/`uv pip install`, `brew install`, `cargo install`, `gem install`, and `npx`/`uvx` running a package) and for paid-cloud create or deploy verbs. Routine creation stays a prompt rule (visible and pausable in Settings). Goes in PR A (`command-risk.ts`), with the eval cases.
- **P2, Full access:** the bot may do the "ask first" actions when the owner's request calls for them, never on its own initiative (the text in `final/instructions.md`).
- **G1:** teammates may post to group chats (`post_to_group` stays allowed for plain bots).
- **F1:** writing `AGENTS.md`/`CLAUDE.md` in an attached project folder runs without a card in Auto.
- **S1:** reword the three starters to match what the app can do.
- **E1:** keep "No em dashes".
- **UI:** the Settings mockup is approved: https://claude.ai/artifact/FJeB9XnxttLJWaxg8Vhipo
- **Deferred items:** real routing of group mentions to the member; hiding teammate tool schemas (phase 2).

## 12. Step 0 results (spikes and probe, 2026-10-01)

Records are in `evals/results/2026-10-01-ub009-spikes/`. All were verified in eve 0.54.3 source; the SBPL result was observed live.

- **Payload baseline** (Test Bot turn, GLM 5.3 Flash):
  - one system message of 19,018 characters;
  - **39 tools whose schemas total 30,483 characters**, the biggest fixed cost (largest: `generate_image`, `todo`, `agent`, `create_routine`, `update_routine`);
  - the teammate prefix on the first user message.
- **JWT bot claim: works.** It's per request, reaches `auth.current.attributes` on the first turn and is persisted for turns eve starts itself.
  - **New:** nothing ties a session to a bot today. The proxy trusts the body's `botId`. PR A's binding takes the bot from the durable record by the session id in the path, never the body. `channelAuth` checks the claim on stream and cancel too.
  - The in-eve refusal lives in the `step.started` model resolver, because a throwing instruction resolver is skipped.
- **Memory slot: works, preferred.** Delivery is user-role `memory.load`, and the same id plus the same content is a no-op.
  - It needs a sentinel record, because a blank recall throws and recall can't retract.
  - Cache the rendered block per `operationId`. `null` scope hides the slot; a throw fails the turn.
- **OpenAPI approval policy: works.** It can await the app's card.
  - It must never throw. Cap the wait at about 150 s (router `REQUEST_TOTAL_MS` 180 s), with one live long-wait test.
  - `operations.allow` is honored.
- **`disableTool()`: works** for `agent` and `task_cancel` (two one-line files; both tools are back on since 2026-10-03, so the files are gone). The unused `agent/subagents/reviewer` keeps eve's agent-messaging block alive, so remove it if no reference remains.
- **SBPL:** this Mac's volume folds case, and the kernel matched the lowercase deny against `.Claude/Settings.json`. `(?i)` loads but matches nothing, so never use it.

## 13. Final check

Fable 5.1 (high), 2026-10-01: **ready with fixes**, 0 critical, 3 high, 6 medium, 8 low (`final/fable-5.1-check.md`). All 17 are applied above and in `final/`. Fable confirmed two premises the plan relied on: custom JWT claims reach `auth.current.attributes`, and eve's connection `approval` takes a custom async policy.

## 14. PR B as built (2026-10-02)

Where the build differs from the sections above, and why:

- **Refusal at write and send, not in `parseShell`.** A throw while parsing the shell store reseeds it, which loses data, so a stored description over 8,000 characters is read verbatim and refused when it is written and when a turn is sent.
- **Handoff envelope.** Its first two lines stay exactly as before, because the Swift and TS parsers match them; the new sentences and the relay-hop line follow.
- **Admission.** Tokens are estimated at 3.5 characters each. The envelope counts the shared prompt, the rendered context and notes blocks, the 30,483-character tool baseline plus the OpenAPI and MCP tools that would actually mount for the session, the output reserve and the hidden notes and carry-over brief. A tool mounted mid-turn, and a model pick in the milliseconds between the last check and eve's turn start, are not covered. Today's envelope is about 18.6k tokens for the Generalist, so small-window models are refused until PR C trims the tool descriptions.
- **Notes.** Renders are persisted per bot and operation (`recall/` beside the notes, newest 256) so a replay after a restart returns the same bytes. A turn that shows an outside-sourced note is marked, so a copy of it is marked too.
- **"This chat" line.** Permission and folder come from the session grant the tools enforce, so a brand new chat shows Read only until its grant is stamped, which matches what its first tool calls do.
- **Settings.** Routines also appear in Settings (the Details pane keeps its list). Notification banners say only "NAME finished", with no reply text, for lock-screen privacy.
