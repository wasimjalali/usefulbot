## Findings

```yaml
- finding: "`tools: []` in createAgentSession disables every custom tool, not just Pi's built-ins"
  severity: critical
  where: "SPEC 5.2"
  evidence: "sdk.js:152-157: `selectedToolNames = options.tools`; `allowedToolNames = options.tools ?? (options.noTools==='all' ? [] : undefined)`. agent-session.js:1138-1144 `_isAllowedTool` returns false for any name the empty matcher rejects, and `_allowlistFiltersMcp` is true when the list is empty, so custom tools are filtered out of the registry too (agent-session.js:2883). The bot would ship with zero tools and no error."
  fix: "Specify `noTools: \"builtin\"` (allowedToolNames stays undefined, custom tools activate on registration per agent-session.js:2960-2961) and never pass `tools`/`allowedToolNames`. Say explicitly that picked MCP tools named `<connectionId>__<tool>` are not `mcp__*`, so an allowlist would also drop them; activation must go through `setActiveToolsByName`."

- finding: "Rows built from the compaction-aware projection delete summarized history from the UI"
  severity: critical
  where: "SPEC 5.12"
  evidence: "session-manager.d.ts: `buildContextEntries` is documented as 'the active, compaction-aware entry list for context/rendering' and omits summarized entries before `firstKeptEntryId`. 'Active branch' in 5.12 is ambiguous; an implementing agent will pick that function and the transcript will shrink after every compaction."
  fix: "Say rows are built from `sessionManager.getBranch()` (the full leaf path, all entries), and that compaction entries render as a note row. Only the model context uses the compaction-aware projection."

- finding: "Retry via `sessionManager.branch()` leaves AgentSession state stale"
  severity: critical
  where: "SPEC 5.5 step 8"
  evidence: "session-manager.d.ts `branch(branchFromId)` only moves the leaf pointer. `agent.state.messages` is refreshed solely by `_refreshFinalizedContext()` (agent-session.js:570-577), which only `navigateTree()` calls (agent-session.js:3379-3381). After a raw `branch()`, `_findLastAssistantMessage`, the pre-prompt compaction check and `agent.state.messages` still hold the failed attempt; `_entryIdsByMessage` is stale."
  fix: "Use `session.navigateTree(failedUserEntryId)` (it moves the leaf to the parent, returns `editorText`, and refreshes state); require it to run only when `isIdle`."

- finding: "Old chats lose images, pages, widgets, notes and routine notes in the migration"
  severity: critical
  where: "SPEC 11.1 / 11.2 / D22"
  evidence: "The export reads only the eve stream (`readSessionEvents`). Per app-map/swift.md §3.2 those rows live in the durable `agents.json` store (`GET /api/agent/state`), not the stream. 11.2 imports 'from the export' only, then D23/11.2 drop `agents.json` threads."
  fix: "Export `agents.json` thread events per bot/session too (ids, kinds, timestamps), import them as `ub.row` entries merged by timestamp with the stream messages, and keep the threads until the import is verified."

- finding: "The follow-up queue is not durable; a queued message can be lost or resurrected"
  severity: critical
  where: "SPEC 5.5 step 3, 5.12 `queued`, D15"
  evidence: "`followUp` keeps messages in memory (agent.js:198-210). `abort()` never clears them (agent.js:221-223, agent-session.js:1971-1982), and nothing on boot restores them. Crash after the second send: the owner's message vanishes with no row and no unsent bubble. Cancel: the stale follow-up can be delivered inside a later run."
  fix: "Persist each accepted-but-undelivered message as a `ub.queued` custom entry, delete/mark it on delivery, and on boot surface leftovers as an unsent row with Resend. On cancel call `session.clearQueue()` and record the discarded text."

- finding: "A queued message never becomes its own turn under Pi, so the UI shows one endless turn"
  severity: high
  where: "SPEC 5.5 step 3, 6.3 mapping table"
  evidence: "agent-session.d.ts: `followUp` is 'Delivered only when agent has no more tool calls or steering messages'; agent-session.js:1547-1549 notes the loop drains both queues before `agent_end`. So no `agent_end`/`agent_settled` boundary exists between the running turn and the queued message. The mapping table has no rule for this, so `message.queued` would never clear and both messages share one `turnId`."
  fix: "Add the rule: a `message_start` with role user while a turn is running closes turn N (`turn.completed`) and opens turn N+1 (`turn.started`), and the host correlates it to the queued `clientId` by FIFO order (Pi gives `queue_update` only plain strings, agent-session.d.ts:47-52)."

- finding: "Assistant rows have no entry id while they stream, so `message.delta.rowId` cannot be the entry id"
  severity: high
  where: "SPEC 5.12 (row id = entry id) + 6.2 (`message.delta {rowId}`, `message.final {rowId}`)"
  evidence: "`UserMessage`/`AssistantMessage` have no id field (pi-ai types.d.ts:363-380). Session listeners are notified before persistence (agent-session.js:752-761), so at `message_end` the entry does not exist yet; `_findPersistedMessageEntryId` is private. The engine cannot know the entry id at delta time."
  fix: "Pin one rule: the host mints the row id at `message_start`, writes it in a `ub.row-id` custom entry (or in the entry's `details`), and rows built from disk reuse it. Say `message.final` always carries the same id as the deltas."

- finding: "Cancel hangs until the running tool returns; approval waits ignore the abort signal"
  severity: high
  where: "SPEC 5.5 step 6"
  evidence: "`abort()` awaits `waitForIdle()` (agent-session.js:1971-1982). `waitUntilNotPending(store, id, timeoutMs = 5 min, 250)` takes no signal (agent/lib/approvals.ts:439-444). Ordering abort-then-expire means a cancel with an open card blocks for up to five minutes (bash up to 30), and `POST cancel` hangs."
  fix: "Expire the chat's cards first, make the shim's approval wait race `ctx.abortSignal`, return 202 from cancel immediately, and emit `turn.cancelled` on `agent_settled`."

- finding: "Live widget and persisted widget rows will both render"
  severity: high
  where: "SPEC 5.10, 5.12, 6.2 `tool.call {widget}`"
  evidence: "Today `rebuildTranscript` dedupes live widgets against durable rows by widget id (AppModel.swift:3095-3099), where the durable row's text is `event.widgetId`. The new protocol's `tool.call` carries no id linking the live widget to the later `row`, and the row spec says only 'ids into the media and widget stores'."
  fix: "Add `callId`/`widgetId` to the widget row and to `tool.call.widget`, and state that the client replaces `live-<callId>` with the persisted row of the same key."

- finding: "`/api/agent/state` deletion orphans connect-card phases and the tick pumps"
  severity: high
  where: "SPEC 7 (`/api/agent/state` delete), SPEC 9 (delete pump code)"
  evidence: "Proposals are polled via `threadState` in `pollOnce`/`refreshDurable` (AppModel.swift:1143, 1619, 2922); connect phases (waiting/connected/failed) change asynchronously in `connect-flow`. `client.tick()` is called only from `pumpHandoffs` (AppModel.swift:1565, 1694), and POST `/api/agent/tick` is what runs `pumpConnects`/`pumpConnections`. Delete both and connectors stop progressing and cards freeze at 'proposed'."
  fix: "Keep a cards endpoint (or have the engine watch `agent-store` and emit updated `card` rows on phase change), and say the app keeps a 2.5 s tick call, or move the connect pumps into the engine."

- finding: "Recents lose title/preview/updatedAt; `touchChat` is neither kept nor removed"
  severity: high
  where: "SPEC 5.4, SPEC 7 `/api/shell` list"
  evidence: "`touchChat` writes `lastPreview`/`lastAt` and pushes recents (shell-store.ts:1147, web-shared.md:149,163). The keep list omits it and nothing else writes previews. The chat list would show blank previews and never reorder."
  fix: "Either keep `touchChat` (engine or app writes it) or make the engine own recents (title from `session_info`, preview from the last assistant text, `updatedAt` from the file)."

- finding: "No event retention, heartbeat or reconnect rule for the NDJSON stream"
  severity: high
  where: "SPEC 6.1/6.2, D11"
  evidence: "6.2 only says 'a client that sees a seq gap or another epoch refetches rows'. There is no statement of how long `after=<seq>` can be honoured, no heartbeat, and no reconnect/backoff. A dead stream after a network blip leaves a stale working row forever; a reconnect older than the buffer has no defined answer."
  fix: "State: events retained per open chat for the process lifetime (or last N per chat); `after` older than the buffer answers `stream.ready` with a fresh `tailSeq` and no events, which the client treats as a gap; heartbeat every 15 s; client reconnects with backoff and refetches when `stream.ready.tailSeq != lastSeq`."

- finding: "Background turns (routines, other bot) no longer notify or show activity"
  severity: high
  where: "SPEC 6.1 `/api/engine/status`, SPEC 9"
  evidence: "Today the app follows every bot's stream (`backgroundProjections`) and `pumpHandoffs` drives `workingBotIds`, the rail pulse, `markReplyReady` and `notifyTurnFinished` (AppModel.swift:1689-1737, 2679-2691). The new design streams only the open chat and returns `{running, waitingOnOwner, replyReady}` with no activity label, no poll cadence and no clear rule for when `replyReady` resets (today it clears when the bot is selected, AppModel.swift:67)."
  fix: "Specify the status poll cadence, add `activity {kind, tool}` per bot, define `replyReady` set/clear (set on a settle the owner did not see, cleared by `POST open`), and wire notifications to the status transition."

- finding: "Approval cards lose the chat/bot context with two bots"
  severity: high
  where: "SPEC 5.9, SPEC 9 approvals"
  evidence: "GET `/api/approvals` resolves `botId`/`botName` and Swift shows `originLabel` ('Sub-agent of X, from another chat', BackendModels.swift:456-465). The spec drops `rootSessionId`, `subagent`, `originLabel` and bot resolution, leaving `{chatId, turnId, callId, botId}` server-side but no chat label in the card, so bot A's card can appear, unlabelled, over bot A's other chat."
  fix: "Keep `botId`/`botName` on the card, add `chatId`, and either filter the poll by the open chat or label the card with its chat."

- finding: "`agents.json`/proposal/`note` writes from the web have no defined path once rows live in the engine"
  severity: high
  where: "SPEC 5.10, 5.12, 7"
  evidence: "Only `/api/agent/widget` is stated to append its row through the engine. `write_file` pages, `generate_image`, connect cards and routine notes are written by other processes today (`appendAgentEvent`). 5.12 says the engine is the only writer of rows and 5.4 that it is the only writer of session files, but the page/image/card write paths are not described."
  fix: "Name the single write path for each row kind (engine tool → `appendRow`; web → engine `POST /internal/rows`), with idempotency by `callId`/store id."

- finding: "PLAN: PR 3 is not independent of PR 2, and two parallel PRs own the same files"
  severity: high
  where: "PLAN Order, PR 2, PR 3"
  evidence: "PR 3 owns 'a call from the tick route' and reads `readSessionEvents` from `web/lib/agent-exec.ts`; PR 2's Node worker owns `web/app/api/agent/tick/route.ts` and `web/lib/agent-exec.ts`. PR 2's Swift worker and PR 3 both own `App/SettingsPaneView.swift`. The plan says 1, 2 and 3 run in parallel."
  fix: "Make PR 3 depend on PR 2 (sequential), or give PR 3 its own route/file and move the Settings line to a file PR 2 does not touch."

- finding: "PLAN PR 4: W1 and W2 cannot both be 'tsc clean' in parallel"
  severity: high
  where: "PLAN PR 4 W1/W2"
  evidence: "W1 builds the host (`customTools`, `ToolCtx`) and its done condition is `npx tsc --noEmit` clean, but `agent/lib/tool.ts` (the shim and `ToolCtx`) is W2's file, and W2 deletes eve-only libs W1 imports. Only the protocol fixtures are orchestrator-owned."
  fix: "Add the shim contract (`agent/lib/tool.ts` types + stub) and the `shared/stack.ts` `enginePort` rename to the orchestrator's first commit, or sequence W2 before W1's host work."

- finding: "PLAN PR 4: nested ownership and missing owner for manual routine run"
  severity: medium
  where: "PLAN PR 4 W1/W5, SPEC 5.11"
  evidence: "W1 owns `agent/engine/**` and `test/engine/**`; W5 owns `agent/engine/import/**` and `test/engine/import/**`. Separately, `POST /api/routines/{id}/run` (W3's `agent-exec.ts`) has no engine route in 6.1/5.11, and the claim/history (`claimManualRun`, `appendRoutineRun`) now lives in the engine."
  fix: "Give W5 `agent/engine/import/**` exclusively (W1 must not scaffold it) and add `POST /internal/routines/:id/run` to SPEC 5.11 with who claims and who records the run."

- finding: "User attachments are not reconstructable from a Pi session"
  severity: medium
  where: "SPEC 5.12 `user` row, 6.1 attachments"
  evidence: "Pi stores images as base64 `ImageContent` with no filename (pi-ai types.d.ts:363-366); text files (64 KB cap, shared/attachments.ts) have nowhere to go once `[file: ...]` lines are banned. Rows must list attachments 'by name and type'."
  fix: "Record `{name, mediaType, size, storeId}` in a `ub.attachments` custom entry keyed to the user entry, and state where text attachment content goes (prompt text in a fence vs. workspace file)."

- finding: "Retry semantics leave the failure row and the optimistic bubble undefined"
  severity: medium
  where: "SPEC 6.1 `retry`, 6.2 `turn.started`"
  evidence: "Today `turn.started` clears failure state (EveStream.swift:1807-1859). The new `turn.started` table only says 'working row on'. Retry re-prompts the same text with a new `clientId`, so the client does not know whether to bind or append the owner bubble, nor to drop the failure row before the refetch."
  fix: "Say `turn.started` with a `retry` flag removes the newest failure row, and that retry reuses the original `clientId` (echoed on `message.user`)."

- finding: "Typed refusals are incomplete for the flows the UI already has"
  severity: medium
  where: "SPEC 5.5 step 1, 6.1"
  evidence: "The refusal list is `model_selection_unavailable`, `provider_route_retired`, `model_no_vision`. The app also gates Retry on a router cool-down (`failureRetryUntil`, AppModel.swift:3136-3162) and shows copy for `session_busy`, `messages_count`, `empty-model-response` (EveStream.swift:307-439). No code is defined for a too-early retry or for `engine_error` copy."
  fix: "Add `retry_too_soon {retryAfterMs}` and `engine_error` to the refusal/failure code table, and state which `TurnFailure` copy survives."

- finding: "Compaction note rows are missing from the row table"
  severity: low
  where: "SPEC 5.12"
  evidence: "5.7 says `compaction_end` writes a quiet row and `compaction.done {rowId}`, but 5.12's kind table maps `note` only from `ub.row`. A `compaction` entry has no `ub.row`, so the note disappears on reload."
  fix: "Add `note` ← `compaction` entry (id = entry id) to the table."

- finding: "Pi API details stated as settings that do not exist in that form"
  severity: low
  where: "SPEC 5.2, 5.3, 5.4, 5.8"
  evidence: "Provider retry is `retry.provider.maxRetries` (settings-schema.d.ts:100-109), not a top-level 'provider retry'. `ProviderConfig` has `streamSimple` only, no `stream` (types.d.ts:1432). `SessionManager.create(cwd, dir)` needs `{id}` as the third argument (session-manager.d.ts NewSessionOptions). `ToolDefinition.parameters` is TypeBox (`TSchema`), and Pi does not validate arguments before `execute` (agent-loop.js:474-486), so contract test 9's fallback is unnecessary. `ask`'s `terminate` only ends the batch when every call in it terminates (agent-loop.js:471-472). The custom `ResourceLoader` also needs `getAppendSystemPrompt`, `getAppendSystemPromptSources`, `getSystemPromptSource`, `extendResources` (resource-loader.d.ts)."
  fix: "Correct these names and add the missing loader methods; note that `ask` should also force the turn to end (or run sequentially)."

- finding: "`shared/stack.ts` renames are under-scoped"
  severity: low
  where: "SPEC 5.1, 13"
  evidence: "`eveOrigin()` (stack.ts:151-153), `DAILY_PORTS`, `PORT_VARS`, and `test/dev-stack.test.ts`'s literal-port grep also carry eve naming; `package.json` `\"start\": \"service.mjs eve\"` is not listed."
  fix: "Add `eveOrigin` → `engineOrigin`, the port tables and the `start` script to the rename list."

- finding: "`<stateRoot>/engine` is already protected"
  severity: none
  where: "SPEC 12"
  evidence: "`APP_STATE_SEGMENT`/`APP_STATE_IN_TEXT` already match `.useful-bot*` (stack.ts:532-534), which covers `engine/`."
  fix: "Drop the redundant item or say it is belt-and-braces."
```

## Dismissed

- `agent_settled` as the only turn end: correct (agent-session.d.ts:39-42; retry/compaction continue after `agent_end`).
- `agent_end.willRetry` and `auto_retry_start`: exist, mapped sensibly.
- `queue_update` exists but carries plain strings: verified, folded into the turn-boundary finding.
- `session.systemPrompt` for envelope measurement: exists (agent-session.d.ts:411).
- `before_agent_start` returning a `custom_message`: exists (`BeforeAgentStartEventResult.message`, types.d.ts:1125-1126); it lands after the user message (agent-session.js:1496-1526), matching "dynamic last".
- `session_before_compact` logging hook: exists (types.d.ts:601-605, 1193).
- `compaction.reserveTokens`/`keepRecentTokens`/`modelOverrides` math for 32k and 200k windows: correct.
- `registerProvider(name, config)` with `refreshModels`, `compat`, `contextWindow`, `maxTokens`, `input`: all present (types.d.ts:1414-1490).
- Built-in `openai-completions` accepts `options.fetch`: confirmed (openai-completions.js:186, 560-565).
- Compat flags in SPEC 5.3: all exist (openai-completions.js:1271-1307, 1323-1350).
- `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`/`PI_TELEMETRY`: exist (environment-variables.md:84-86).
- Project trust: no `.pi` resources under the engine cwd and a custom loader returns no agents files, so no prompt.
- `approvalActor`, `expireSession`, `invalidateOnRestart` exist; the claim that `invalidateOnRestart` has no production caller is correct.
- Approvals are not on the eve stream; the 1.5 s poll is engine-neutral: correct.
- `readSessionEvents` caps and the 12k-event chat: plausible for export; the 20k tail cap covers it.
- `.eve/` never deleted, Markdown archive: no data-loss path there.
- `write_file`/`bash`/sandbox/command-risk staying as-is: matches app-map/agent.md §6.
- Pi's `tool_call` gate and `block`: exists (types.d.ts:1089-1092, 1224).
- `Terminate` in tool results: exists (agent-loop.js:471-472).
- `AppModel` `replyReady` clears on selection: verified; the gap is that the spec never says who clears it server-side.
- The rail's `WAITING ON YOU` precedence and `BotFacePose(activity:)` dependency on `TurnActivity`: understood, no protocol contradiction.
- `getBranch` returns custom entries and custom entries stay out of model context: correct.
- PR 1's router changes and line cites (`index.ts:439-442`, `:388`, `:253`, `:340`, `:353`, `inline-think.ts:312-355`): consistent with the router map; no contradiction found.
- PR 2's `disableTool` for eve `agent`/`task_cancel`: documented in eve.
- PR 5 perf fixture rebuild and `perf:check` placement before the release: consistent with the repo rule.
- Swift file/line citations I spot-checked (`EveStream.swift` 920-2433, `Transcript.merge`, `RailView.swift:720-733`, `AppModel.swift:3095-3099`, `Proposal.swift` kinds): accurate.

## Verdict

Not ready. The protocol has three holes that would each produce a visibly wrong app on the first day (row ids for streaming messages, queued messages never becoming turns, and rows built from the compacted projection), and the Pi embedding as written yields a bot with no tools at all. The migration would also silently drop every image, page, widget and note from old chats, and PR 2/PR 3 cannot actually run in parallel as planned. Fix the critical and high items, pin the row-id and turn-boundary rules, and re-check the PLAN's file ownership; after that it is implementable.
