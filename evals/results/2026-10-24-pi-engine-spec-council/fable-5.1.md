# Fable 5.1 council review (raw), 2026-10-24

Focus: architecture, durability, protocol, migration, delivery order.

## Findings

1. critical. PLAN PR 5 deletes every user's eve data. `.eve/` lives under the runtime install root (`~/Library/Application Support/Useful Bot[ Dev]/app/.eve/`), and the app refreshes that folder with `rsync -a --delete --exclude /.eve/` on every version change. PLAN PR 5 drops that exclude "one release later"; the next rsync then deletes `.eve/` before anyone can import it. Anyone who skipped 1.3.0 loses every old chat, and D23 is violated. Evidence: RuntimeInstall.swift:195-200; shared/stack.ts:541-547. Fix: keep the exclude until `engine/migration.json` records a successful import for that install root; SPEC 11.2 must name the absolute root it reads; Settings "Remove old engine data" is the only deletion path.

2. high. Export-first migration assumes users pass through 1.2.0. Sparkle offers the newest release, so a user who does not launch between the two releases goes 1.1.x to 1.3.0 and never runs PR 3's export. The offline devalue chunk reader is therefore the primary path and must be tested as such; it needs `devalue` as an explicit dependency once eve leaves; the converter must strip the hidden `SESSION_NOTE_LEAD` prefixes and `[file: ...]` echo lines. Evidence: package.json:37-41; shared/continuation-brief.ts:22,209; Attachments.swift:96-155. Fix: make the chunk reader the specified path with its own contract test on a copied dev-app store; demote PR 3 to optional (I would drop it); add `devalue` (exact pin); specify prefix and echo-line stripping and the `shell.json` remap `bot.sessionId -> chatId` plus recents reshape in 11.2.

3. high. Turn boundaries are wrong with Pi's follow-up queue. The agent loop drains follow-ups inside one run (no `agent_end` between them) and `agent_settled` fires once at the very end. With one queued message, turn 1 never gets `turn.completed` until turn 2 finishes. SPEC 5.5 step 3 contradicts step 5. Evidence: pi-agent-core/dist/agent-loop.js:197-212; agent-session.js:1449-1471, 1531-1565. Fix: queue in the host; emit `message.queued`; call `session.prompt()` after `agent_settled`. One prompt = one turn. Keep `followUp()` unused.

4. high. Row ids do not exist while streaming. Pi assigns an entry id only when `message_end` persists the message. Evidence: agent-session.js:755-770. Fix: live events use provisional ids minted by the host (`<turnId>/u`, `<turnId>/a<n>`); `message.user` and `message.final` carry both `rowId` and `entryId`; the client remaps once.

5. high. The event stream has no defined buffer or connect order; `seq` ownership across LRU eviction undefined; rows-then-events race undefined. Fix: the host owns `seq` per chat per epoch and a ring buffer (2,000 events or 10 minutes); `after` older than the buffer answers `stream.ready {resync: true}`; connect order: open events first, then fetch rows, drop events with `seq <= tailSeq`. Consecutive assistant text entries within one turn merge into one row; text-less assistant messages produce no row.

6. high. PR 4 leaves files unowned: `shared/shell-store.ts`, `shell-io.ts`, `web/app/api/shell/route.ts`, `web/app/api/routines/[id]/run/route.ts` (imports `startRoutineNow` from agent-exec), `web/app/api/memory`, `shared/session-selection.ts`, `shared/context-blocks.ts`, `agent/instructions.md`, Swift `BackendModels.swift`, `RailView.swift`, `SettingsPaneView.swift`, `PickerViews.swift`. Fix: add a shell/web worker or extend W3; give W4 the Swift files; name the shell schema migration owner.

7. high. Retry branches behind Pi's back. `sessionManager.branch()` moves the leaf but leaves `agent.state.messages` stale. Evidence: session-manager.d.ts:347; agent-session.d.ts:869, agent-session.js:3261. Fix: use `session.navigateTree(parentOfUserEntry, { summarize: false })`, then `prompt(sameText, { images })`; it throws while streaming.

8. high. `ask` with `terminate: true` only ends the run if every tool result in the batch sets it. Evidence: pi-agent-core/dist/types.d.ts:76-80, 391. Fix: in the `tool_call` gate block every other call in a batch containing `ask`; host marks `waitingOnOwner` from the `ub.question` row.

9. low. Boot-time interrupted scan reads every recent chat file; a `prompt()` that throws leaves a dangling `ub.turn-start`. Fix: `engine/running.json {chatId, turnId}` written at start, cleared at settle; scan only those; write `ub.turn-end {outcome: refused}` when `prompt()` rejects.

10. low. Session file path is `<timestamp>_<id>.jsonl`, resolved by header id. Evidence: session-manager.js:713, 1427-1433. Fix: create with `SessionManager.create(cwd, dir, {id: chatId})`, reopen with `findById` then `open`.

11. low. `ModelRuntime.create` returns a Promise; per-model compaction is `compaction.modelOverrides` keyed by `<provider>/<modelId>`; a custom ResourceLoader must implement `getAppendSystemPrompt`, `getSystemPromptSource`, `extendResources` and reload hooks. Evidence: model-runtime.d.ts:56; settings-schema.d.ts:6-14; resource-loader.d.ts:32-60.

12. low. Engine crash-loop guard missing: boot must never throw on one bad chat. Fix: mark a chat that fails to load `unreadable` (failure row) and continue.

## Dismissed

- Separate engine process behind the web proxy: right shape (Next dev hot reload, route-module duplication, request lifecycle; merging into the router would mix egress policy with tool execution). Care point: the Next passthrough must stream without buffering.
- D15 acceptable; user text is on disk before the model call.
- Pi compat flags all exist with those names (pi-ai/dist/providers/compat-schema.d.ts:64-139).
- Custom `fetch` and `onPayload` are injectable into the built-in openai-completions stream (openai-completions.js:186-188; pi-ai types.d.ts:58,69).
- SettingsManager.inMemory, cacheWarming, retry.maxRetries, provider retry, defaultTools exist (settings-manager.d.ts:70,125-160).
- PI_OFFLINE, PI_SKIP_VERSION_CHECK, PI_TELEMETRY exist (environment-variables.md:84-86).
- before_agent_start may return a custom message (types.d.ts:1125); appendEntry, setActiveTools, registerTool, registerProvider, session_before_compact, before_provider_headers, tool_call block exist (types.d.ts:1193-1358).
- custom entries never enter model context, safe to interleave mid-run.
- agent_settled is emitted in a finally, so a throwing prompt still settles (agent-session.js:1468-1471).
- Compaction trigger formula and keepRecentTokens cut rule match.
- Pi's parser tolerates a truncated last line.
- Approvals across restart: BOOT_EPOCH, expireSession, invalidateOnRestart exist (approvals.ts:26,359,381).
- Two bots at once: router concurrency keyed per session id, no cross-bot blocking.
- Delivery order keeps main runnable at every merge; PR 2 on eve is the riskiest intermediate state.
- Over-engineering check: LRU, epoch/seq, ub.turn-* entries, status route earn their place. Registering the whole catalog as Pi models is more than needed (register the bot's selections lazily) but harmless.

## Verdict

The architecture is right and the Pi API claims hold. Not ready yet: the `.eve/` exclude removal would destroy user data, the migration's primary path is the one the spec calls a fallback, and three protocol details (turn boundaries with the follow-up queue, streaming row ids, event buffer and seq ownership) would make W1 and W4 build incompatible things. With those fixed, plus the PR 4 ownership gaps filled, implementing agents can build from it.
