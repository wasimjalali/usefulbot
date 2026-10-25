# Pi engine: delivery plan

> **Owner, 2026-10-25 13:42: the Pi release ships as a brand-new app.** The owner is the only user, so there is
> no migration and no compatibility code for older installs: no `shell.json` v1 migration, no archived or
> earlier bots, no moved routines, no first-launch note, no OpenAPI note, no image-prompt backfill, no eve
> leftovers kept for a release (PR 4 is folded into PR 3). A store whose format changed starts fresh; stores
> whose format didn't (providers, config, Keychain, memory, routines, connections, media) keep working with no
> extra code. Where this file says otherwise, this note wins.

Status: draft 3, 2026-10-25 (one bot, chat-first UI; `UI.md`). Companion to `SPEC.md` (decisions D1 to D26, sections cited as
SPEC 5.3 and so on). Each PR below is one session's work. An implementing agent reads this file,
the SPEC sections it names and the matching `app-map/*.md`, then builds.

## Order

```
PR 1  router accepts Pi requests                 main   (eve still runs)
PR 2  one strong bot                             main   (eve still runs)
PR 2b chat-first UI to the approved mockups      main   (eve still runs)
PR 3  engine swap, feature branch feat/pi-engine -> main as one PR
        orchestrator contract commit, then W1 engine, W2 tools, W3 web and ops, W4 Swift
PR 4  folded into PR 3 (no one-release leftovers)
```

- PR 1 and PR 2 are independent and can run in parallel sessions (no shared files).
- PR 2b starts after PR 2 merges, and merges before PR 3's W4 starts (they share Swift files).
- PR 3 starts after PR 1, PR 2 and PR 2b merge. It ships in one release with the clean slate (SPEC D22, D23).
- PR 4 lands in the release after PR 3's.

Every PR follows the global change loop: worktree, build, self-check (`npx tsc --noEmit` for the
root, `router/` and `web/` separately; node tests; `macos/test.sh` when Swift changes), live check
in Useful Bot Dev (with its one bot after PR 2), artifacts in `verify/<branch>/`, docs updated, PR, review, merge,
then `npm run build:dev-app` and `npm run install:dev-app` from main. Full E2E suites run only
after a PR's last review round; a newly written spec runs on its own first.

Reviews (GPT paused until 2026-11-01: Opus takes the GPT slot, GLM 5.3 runs beside it):

| PR | Row | Reviewers |
|---|---|---|
| 1 | feature | Sonnet + Opus + GLM 5.3, medium |
| 2 | feature, stored roster state | Sonnet + Opus + GLM 5.3, high |
| 2b | feature | Sonnet + Opus + GLM 5.3, medium |
| 3 | sensitive (process auth, state, concurrency, data drop) | Sonnet + Opus + Opus + GLM 5.3, high; split by worker area so every file has one reviewer |
| 4 | small | Sonnet, medium |

---

## PR 1: router accepts Pi requests

**Goal:** the router takes what Pi's `openai-completions` client sends, while eve keeps working.

**Owns:** `router/src/index.ts`, `router/src/inline-think.ts`, `shared/inline-think.ts`,
`router/test/contracts.test.ts`, `test/inline-think.test.ts`, new `router/test/fixtures/
pi-request.json`, new `scripts/restamp-registry.mjs`, new `scripts/dev/pi-golden-payload.mjs`.

**Change (SPEC 8):**
1. Accept `max_completion_tokens` as an alias of `max_tokens`; replace the `> 4096` refusal
   (`index.ts:439-442`) with a clamp to the resolved output cap, before the reservation
   (`index.ts:636`).
2. Accept and drop `store`, `reasoning_effort`, `prompt_cache_key`, `prompt_cache_retention`
   (extend `DISCARDED_SAMPLING_KEYS`, `index.ts:388`); map role `developer` to `system`
   (`index.ts:253`, `:340`).
3. Extend `withoutReasoning`, `rewrapThinkHistory` (`inline-think.ts:312-355`) and message
   validation (`index.ts:353`) to `reasoning`, `reasoning_text`, `reasoning_details`.
4. Keep `tool-finish.ts` (eve needs it until PR 3).
5. `scripts/restamp-registry.mjs`: writes `sha256(package-lock.json)` into both
   `packageLockHash` fields of `shared/registry.json`.

**Golden payload:** `scripts/dev/pi-golden-payload.mjs` builds a request with
`@earendil-works/pi-ai`'s `openai-completions` builder from the globally installed Pi (dev only,
not a dependency), using SPEC 5.3's compat, a tool call history, an image and a reasoning field;
it writes `router/test/fixtures/pi-request.json`. The contract test asserts the router accepts it
and forwards the expected upstream body.

**Verify:** all router tests green; live, one normal turn in Useful Bot Dev still works on eve.

---

## PR 2: one strong bot

**Goal:** one all-round bot and a chat-first sidebar; no second bot, groups, sections, cross-bot
tools or sub-agents. Still on eve. Decisions SPEC D5 to D9, D20, D25 and the "PR 2" rows of
`UI.md` section 9. The chat-first UI was held for the owner's mockup approval and lands in PR 2b;
PR 2 builds the decoding, payloads and removals it needs. Tool merges (D21) wait for PR 3.

**Node worker owns:**
- delete `agent/tools/{list_bots,rail_action,delete_bot,propose_bot,propose_group,post_to_group,
  send_to_bot,update_bot_profile,clear_history,review,list_models}.ts`;
- `agent/instructions.md` (one bot, under 950 words, no team, peer, handoff, sub-agent or
  reviewer text), `agent/skills/**`, `test/prompt-texts.test.ts`, `test/skills.test.ts`;
- `agent/lib/permission.ts` (drop caller roles), `agent/lib/active-bot.ts`,
  `agent/lib/turn-snapshot.ts` (sub-agent and roster parts), `agent/agent.ts` (`disableTool` for
  eve `agent` and `task_cancel`);
- `shared/shell-store.ts`, `shared/shell-io.ts`, `shared/threads.ts` (delete group and mention
  code; keep `stripThreadPrefix` and the default bot id, which other files still import),
  `shared/context-blocks.ts`, `shared/admission.ts` (group branch), `shared/agent-store.ts`
  (bot, group, profile and fan-out proposal kinds), `shared/bot-face.ts`, `shared/subagent-stops.ts`,
  `shared/routines-store.ts` (`movedFrom`, the migration's direct write, `parseRoutine` keeps it),
  `agent/lib/memory.ts` (`moveBotNotes`), `web/app/api/memory/route.ts` (`total`),
  `web/app/api/routines/**` (`movedFrom` out, cleared on edit or activate);
- `web/app/api/shell/route.ts`, `web/lib/agent-exec.ts` (fan-out, first brief, cross-bot
  deliveries; **keep** the handoff pump for connect-card resume, the only remaining handoff use),
  `web/app/api/agent/tick/route.ts`, `web/lib/eve-session-auth.ts` (child-stream verification),
  `web/app/eve/v1/[...path]/route.ts` (child stream and child cancel), `shared/eve-proxy.ts`
  (child parsing, mentions), `web/app/api/approvals/route.ts`, `web/app/api/reviewer/` (delete);
- tests: `cross-bot`, `multi-agent`, `agents`, `envelopes`, `admission`, `session-binding`,
  `turn-snapshot`, `first-brief`, the group cases of `shell-store` and `context-blocks`.

Rules it builds:
- One bot: `createBot` and `deleteBot` shell actions are removed; the app always uses
  `bot-useful`. `select` stays only for the perf harness in the dev stack (it refuses any bot other
  than `bot-useful` and the perf fixture bots); PR 3 deletes it.
- Archive (D6): a one-time shell migration (marker `shell.json.archived-v1`) marks every bot except
  `bot-useful` `archived: true` and deletes nothing. Their routines move to `bot-useful` with
  `active: false` and `movedFrom: <old botId>`, written directly past `ROUTINES_PER_BOT_MAX` (the
  cap still applies to new routines); a name that clashes gets " (from OLD BOT NAME)". Their memory
  notes stay under their own id.
- `moveNotes {fromBotId}`: a new `MemoryStore.moveBotNotes(from, to)` rewrites each note's
  front-matter `botId`, bumps its revision and sha, updates the index row, and bypasses the
  immutable-botId guard of `upsert` (`agent/lib/memory.ts:585`); it is the only way a note changes
  bot. `removeArchivedBot {botId}` deletes the archived record and archives its notes.
  `GET /api/memory` adds `total` (the store's `countLive`) so Earlier bots shows the real count.
- Perf (dev stack only): the perf fixture bots named in `perf/fixtures.dev.lock.json` stay
  unarchived, never appear in the sidebar, and are reached by `PerfHarness` through the dev-only
  `select`, until PR 3 replaces them with fixture chats.
- Live checks: the dev app's one bot replaces "Test Bot"; PR 2 updates that line in `AGENTS.md`.
- Chat list on eve data: current chat (`bot.sessionId`) plus `recents` (title, preview,
  `updatedAt`) of `bot-useful`; New chat and open use the existing `newChat` / `openRecent` actions
  until PR 3 replaces them.
- `GENERALIST_SEED_V3` without team language.

**Swift worker owns** (removals, decoding and payloads only; the chat-first UI is PR 2b):
`App/RailView.swift` (only `bot-useful` shows, no create or delete bot), `App/RootView.swift`
(create-bot and create-group dialogs, sections), `App/PickerViews.swift` (bot picker out),
`App/ProposalCardView.swift`, `App/SettingsPaneView.swift` (group parts out),
`App/AppSettingsView.swift` (reviewer row), `App/ChatDetailsPaneView.swift`, `App/ChatView.swift`
(sub-agent cards, handoff and post strips, group header), `App/SubagentCard.swift` (delete),
`App/AvatarStackView.swift` (delete), `App/ProvidersPaneView.swift` (reviewer row),
`App/ComposerView.swift` (group placeholder), `Core/SubagentRuns.swift` and
`Core/SubagentCard.swift` (delete), `Core/Threads.swift` (keep `defaultBotId`),
`Core/ChatAttribution.swift` (delete), `Core/ShellActions.swift`, `Core/Proposal.swift`,
`Core/TranscriptBlocks.swift`, `Core/Transcript.swift`, `Core/BackendModels.swift`,
`Core/Routines.swift` (`movedFrom`), `App/PerfHarness.swift` (fixture bots through the dev-only
`select`), the sub-agent branches of `Core/EveStream.swift`, `App/AppModel.swift` (sub-agent
branches, bot selection except the dev-only path `PerfHarness` uses, create and delete bot, sections and the bot picker), and the Swift tests that cover these
(`SubagentCardTests`, `SubagentRunTests`, `ThreadsTests`, `ChatAttributionTests`, the group and
fan-out cases of `TranscriptTests`, `TranscriptBlocksTests`, `ProposalTests`, `ShellActionsTests`).

**Verify:** node and Swift suites green. Live in Useful Bot Dev: the bot runs a turn with bash and
an approval; a routine runs; asked to "use a sub-agent", the bot does the work itself; connecting an
app resumes the chat.

---

## PR 2b: chat-first UI

**Goal:** the UI held from PR 2, built to the approved mockups (`UI.md`, artboards in
`docs/plan/pi-engine/mockups/chat-first-useful-bot.html`), on eve data. The "PR 2" rows of `UI.md`
section 9 that PR 2 did not build, plus the Connectors polish of `UI.md` 8b.

**Swift worker** (sonnet-worker) owns: `App/RailView.swift` (the chat-first sidebar of `UI.md` 3:
logo, fixed rows, chat list by day, dots ring for a working chat, pencil New chat, account row with
the owner name), new `App/RoutinesPage.swift` (`UI.md` 5, built from the routine views of
`ChatDetailsPaneView.swift`), `App/LibraryView.swift` (stage page), `App/RootView.swift` (stage
routing; `ConnectorsDialog` and `ConnectorDetailPage` polish of `UI.md` 8b), `App/PickerViews.swift`
(Chats, Library, Routines tabs), `App/SettingsPaneView.swift` (its instructions and memory sections
move into the new Settings tab; the pane and its toggle go), `App/AppSettingsView.swift` (the
Instructions and memory tab of `UI.md` 6, notify and Earlier bots in General, 244pt nav so "Instructions and memory" fits on one line),
`App/ChatView.swift` (empty header, logo empty chat, dots working row, "From another chat"
approval label), `App/UsefulBotApp.swift` (⌘N and the other shortcuts of `UI.md` 11),
`Core/BackendModels.swift` (`needsSignIn` on connected apps, `risk` on tools), and the Swift tests
that cover these.

**Node worker** (sonnet-worker) owns: `web/app/api/connectors/route.ts` (`needsSignIn` per
connected app), `web/app/api/connectors/tools/route.ts` (`risk` per tool from `connectorRisk`; move
it to `shared/` if the web build can't import `agent/lib`), and their tests.

**Verify:** node and Swift suites green. Live in Useful Bot Dev: the sidebar matches the approved
artboards (fixed rows, chat list, account row); New chat and opening a recent chat work; the
Routines page shows the moved routines paused; Settings > Instructions and memory edits
instructions and lists notes; Settings > General > Earlier bots copies instructions and moves
notes; Connectors shows Sign in again on an expired app and an app's tools grouped into reads and
writes. Screenshots, light and dark, side by side with the After artboards.

---

## PR 3: engine swap (feature branch `feat/pi-engine`)

**Goal:** SPEC 5 to 9 and 11 to 14. eve is gone; the app runs on the Pi engine with a clean slate.

### Step 0: orchestrator contract commit (before any worker starts)

In `.claude/worktrees/pi-engine` from main:

1. **Renames** (SPEC 13 rename table), mechanical, all call sites: `shared/stack.ts`,
   `shared/policy.ts`, `scripts/service.mjs` mode and `servicePorts()`, `package.json` scripts,
   `shared/launchd-render.ts`, `ops/launchd/`, `web/lib/api-guard.ts`, `tsconfig.json`,
   `.gitignore`. Swift renames are W4's.
2. **Tool contract:** `agent/lib/tool.ts` with `ToolCtx`, `RowInput`, `defineTool` (SPEC 5.8) and
   a working shim; `agent/tools/index.ts` exporting `allTools(): ToolDefinition[]` (W2 fills it).
3. **Host interfaces (stubs W1 implements, others call):** `agent/engine/api.ts` with
   `appendRow(botId, chatId|null, row)`, `systemTurn(botId, key, text)`, `runRoutine(id)`,
   `botContext(botId)`; `shared/shell-store.ts` gains the signature
   `setBotChat(botId, chatId, preview, at)` (W3 implements).
4. **Protocol fixtures:** `test/fixtures/chat-protocol/` with `rows-page.json`,
   `events-turn.ndjson` (deltas, a tool call, search results, a widget, a question),
   `events-failure.ndjson`, `events-queue.ndjson` (three sends, one cancel), `events-compaction.ndjson`,
   `events-resync.ndjson`. W1 tests its output against them; W4 tests its client against them.
5. `package.json` dependency diff (remove `eve`, `just-bash`, `ai`, `@ai-sdk/openai-compatible`,
   `postinstall`, `s1`; add `@earendil-works/pi-coding-agent`, `turndown`, exact), `npm install`,
   `node scripts/restamp-registry.mjs`. The tree will not type-check until the workers finish;
   that is expected on the feature branch.

### Workers (4 on the Mac, each in its own worktree from the contract commit)

**W1 engine core** (sonnet-sweeper; the orchestrator's brief carries the host design):
`agent/server.ts`, `agent/engine/**` (`pi-host.ts`, `provider.ts`, `chats.ts`, `turns.ts`,
`queue.ts`, `rows.ts`, `events.ts`, `context.ts`, `routines.ts`, `internal.ts`, `http.ts`,
`migrate.ts`, `api.ts`), `agent/lib/{router-fetch,router-identity,turn-snapshot,
outside-content}.ts`, `test/engine/**`, `test/turn-snapshot.test.ts`,
`test/router-identity.test.ts`. Builds SPEC 5.1 to 5.7, 5.11, 5.12, 6, the boot-time migration
runner of SPEC 11 (`migrate.ts`, which calls W3's store functions) and contract
tests 1 to 8 and 11 to 14 against a fake router (`test/engine/fake-router.ts`). Also the chat
routes of SPEC 5.4 and 6.1 (list paging, rename, delete to trash with the 30-day purge, search,
per-chat status with `cleanSlateNotice`) and routine chats (5.11). Done when those
pass, the fixtures match, and `npx tsc --noEmit` is clean for `agent/engine` and `agent/server.ts`.

**W2 tools** (sonnet-worker): `agent/lib/tool.ts` (beyond the contract), `agent/tools/**`,
`agent/lib/{approvals,write,permission,memory,workspace,sandbox,run-command,command-risk,
cli-registry,connector-risk,guard-hint,lenient-null,model-window}.ts`, `agent/skills/**`,
`agent/instructions.md`; deletes `agent/agent.ts`, `agent/channels/`, `agent/connections/`,
`agent/hooks/`, `agent/sandbox/`, `agent/memory/notes.ts` (renderer into `shared/notes-block.ts`),
`agent/instructions/context.ts`, `agent/lib/{active-bot,channel-auth,openapi-approval,
session-model,session-owners,web-fetch-fence}.ts`; `shared/{connection-tools,
connection-tools-store,tool-wire-size,notes-block,json-schema-zod,mcp-apps,connection-auth}.ts`;
`scripts/tool-schema-size.mjs`; tests `lenient-tool-input`, `mcp-on-demand`, `connection-tools`,
`connector-tools`, `cli-tools`, `images`, `agent-tools`, `planted-config`, `openapi-approval`
(delete), `notes-slot`, `write-approval`, `memory`, `command-risk`, `sandbox`, `approvals-persist`,
`routines`, `skills`, `tool-cap`, `tool-schema-size`, `prompt-texts`, `fixture-tool` (delete),
`spikes/s3/approvals.test.ts`. Builds SPEC 5.8 to 5.10 and contract tests 9 and 10. Done when
those tests pass and the 16 tools' schemas total under 15,000 chars.

**W3 web, shared and ops** (sonnet-worker): `web/app/api/**` per SPEC 7 (new `chats`,
`engine/status`, `proposals`; changed `agent/tick`, `agent/widget`, `routines/[id]/run`, `status`,
`shell`, `approvals`, `bots/context`; deleted `agent/state`), `web/app/eve/**` (delete),
`web/lib/{agent-exec,eve-session-auth,image-regenerate,providers-write}.ts`,
`shared/{eve-proxy,eve-stream,continuation-brief,session-bindings,admission,workspace-store,
agent-store,shell-store,shell-io,threads,handoffs,agents-send,subagent-stops,bot-face,
context-blocks,session-selection,connect-flow,connection-flow,media-store,widgets-store,
routines-store,turn-input}.ts` (routines-store: `chatId` and run `chatId`, SPEC 7), `router/src/tool-finish.ts` (delete) and its uses in `router/src/index.ts`,
`scripts/{service,verify,build-runtime,setup-local,smoke-runtime,patch-eve,ios-contract-fixtures,
ios-pairing-gate}.*`, `test/fixtures/ios-contract/**`; tests `eve-stream`, `eve-proxy-guard`,
`channel-auth`, `session-owners`, `session-binding`, `continuation-brief`, `handoff-stream`,
`cross-bot`, `multi-agent`, `first-brief`, `agents`, `envelopes` (delete or rewrite), `admission`,
`model-switching`, `shell-store`, `seed-overlay`, `context-blocks`, `launchd-render`,
`setup-local`, `router-entry`, `ios-contract`, `dev-stack`, `widget-sweep`, `media-store`,
`connect-flow`, `connection-flow`, the tool-finish cases of `upstream-adapters` and
`local-stream-usage`, `router/test/contracts.test.ts` (tool-finish cases). Builds SPEC 7, 8
(tool-finish), 11 (the `shell.json` v2 migration function in `shell-store.ts` and the
image-prompt backfill function in `media-store.ts`, both called by W1's `migrate.ts`), 13. Done when web routes pass
against a stub engine and `npx tsc --noEmit` is clean for `web/` and `router/`.

**W4 Swift** (sonnet-sweeper): every file under `macos/Sources/**` and `macos/Tests/**` that SPEC
9 names, including `Core/{EveStream,BackendClient,BackendModels,Transcript,TranscriptBlocks,
ReplayGate,ChatSnapshot,UnsentMessages,Attachments,LocalServices,ServiceSupervisor,AppVariant,
RuntimeInstall,ShellActions,Proposal}.swift`, `App/{AppModel,ChatView,RailView,PickerViews,
SettingsPaneView,TurnNotifier,ComposerView,PerfHarness,RoutinesPage}.swift`, and the tests in
`app-map/swift.md` 7.1 to 7.3. Builds against the protocol fixtures; no running engine needed until
integration. Also the "PR 3" rows of `UI.md` section 9: the sidebar moves from shell recents to
`/api/chats`, gains the per-chat state marks, rename, delete, the routine clock mark, message-text
search hits, the Dock badge and the first-launch note. Done when `macos/test.sh` passes and the app
builds.

### Ownership rules

- Orchestrator only: `package.json`, `package-lock.json`, `shared/registry.json`,
  `shared/stack.ts`, `shared/policy.ts`, `tsconfig.json`, `.gitignore`, `AGENTS.md`, `README.md`,
  `perf/**`, `scripts/perf-fixtures.mjs`, `scripts/restamp-registry.mjs`, `test/fixtures/
  chat-protocol/**` and the `npm test` list.
- Step 0 stubs (`agent/lib/tool.ts`, `agent/tools/index.ts`, `agent/engine/api.ts`, the
  `setBotChat` signature) are written by the orchestrator; after step 0 each belongs to the worker
  whose list names it (`agent/engine/api.ts` W1, `agent/lib/tool.ts` and `agent/tools/index.ts`
  W2, `shared/shell-store.ts` W3).
- A worker that needs a change outside its list reports back instead of editing.
- Any file that mentions eve and is not listed above belongs to the worker whose folder it is in
  (`agent/` W2 unless under `agent/engine` or the W1 lib list; `web/`, `shared/`, `scripts/`,
  `router/` W3; `macos/` W4). Before opening the PR the orchestrator runs
  `git grep -n -E '\beve\b|node_modules/eve|eve/v1|evePort|eveOrigin|EVE_|UB_EVE' -- ':!docs' ':!evals'`
  and every hit must be one of the one-release-kept items (the Swift supervisor's eve process
  patterns and the engine's boot-time eve-listener kill, SPEC 5.1 and 9), removed in PR 4.

### Integration (orchestrator)

1. Merge W1 to W4 into the feature branch; rewrite the `npm test` list; run every suite.
2. `scripts/perf-fixtures.mjs` writes the four synthetic fixture chats (SPEC 14 Perf); update
   `perf/config.json`, `perf/runner/perfguard.py` (rows marks, snapshot cases out, fixture check by
   entry count), `perf/README.md`, re-lock.
3. `npm run build:dev-app`, `npm run install:dev-app` (shared resource, orchestrator only).
4. E2E scenario of SPEC 14 through the heavy lock; artifacts in `verify/feat/pi-engine/`. It
   includes reopening an older chat and finding its note rows and connect cards intact.
5. Golden eval: the eve baseline runs on main before step 1, the Pi run here (owner approves the
   spend first). Write-up in `evals/results/`.
6. `perf:check` baseline on the new engine; review budgets; commit the records.
7. Docs: `AGENTS.md`, `README.md`, `docs/audit/SCOREBOARD.md`, this plan's status.
8. Contract check (`UI.md` section 9): every route in `web/app/api/**` and every event type of
   SPEC 6.2 has a UI row, or is internal (SPEC 6.5), health or auth; every UI row has its route.
9. One PR to main; the review row above; then merge, build and install the dev app.

---

## PR 4: one-release-later cleanup

Remove the eve patterns from the Swift supervisor (`isStrayServiceLine`, `isOwnNodeProcess`) and
the engine's eve-listener kill at boot, once every install has run the PR 3 release. Delete any
`.eve` reference left in `RuntimeInstall.swift`. Small-PR review row.

---

## What the owner decides or does

- Decided 2026-10-25: one bot only (D5, D6), OpenAPI dropped (D17), reviewer role removed (D25).
- Approved the UI mockups on 2026-10-25 (`UI.md`, `mockups/chat-first-useful-bot.html`); the UI
  lands in PR 2b.
- Approve the golden-eval spend (two runs of 10 tasks on his subscriptions).
- Before the PR 3 release deploys the site (`site/public/`, its copy is already one-bot in the repo since #218),
  retake its screenshots from the one-bot app (`/shots/chat.png`, `models.png`, `connectors.png`,
  `routines.png`) and delete the unused `/shots/bots.png`.
- Ship the PR 3 release when he decides (`npm run release:mac`); its notes say old chats are not
  carried over.
