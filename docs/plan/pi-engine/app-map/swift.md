# Swift side map: eve coupling, transcript model, multi-bot surface

Ground truth as of `main` @ 9dc43a0f (2026-10-24). Read-only. Paths are relative to `/Users/wasimjalali/Desktop/useful-bot/macos/`:
`Core/` = `Sources/UsefulBotCore/`, `App/` = `Sources/UsefulBotApp/`, `Tests/` = `Tests/UsefulBotCoreTests/`. Line numbers are in the named file.

## 0. Findings that change the spec

1. **There are no persisted tool rows, step rows or reasoning rows.** The transcript has bubbles, failure rows, compaction notes, widgets, images, pages, handoff/post/note strips, "unsent" rows and sub-agent cards. Tool calls, steps and reasoning only drive one ephemeral `WorkingRow` label (`TurnActivity`, Core/EveStream.swift:96-206; App/ChatView.swift:1890-1965). Nothing else needs to carry them.
2. **Approvals are not on the eve stream.** `ApprovalItem` comes from `GET /api/approvals`, polled every 1.5 s (App/AppModel.swift:954-975), decided with `POST /api/approvals/{id}` (Core/BackendClient.swift:807-820). The stream-side `input.requested` handler explicitly ignores tool approvals (Core/EveStream.swift:2479-2483). Only `question` and "everything else" (session-limit, unknown kinds) come off the stream.
3. **Two sources of truth are merged by text matching.** Chat turns live only in the eve session (stream replay). Side-channel rows (notes, handoffs, posts, widgets, images, pages, proposals) live in the durable store (`GET /api/agent/state`). `Transcript.merge` (Core/Transcript.swift:77-188) pairs them by text counts. Most replay/fold complexity exists because of this split plus eve's journal semantics.
4. `StreamProjection` (Core/EveStream.swift:920-2433, 1,514 lines) is the single largest eve-bound unit and is `Codable` (snapshots). Its fold logic is the thing the spec replaces.
5. The Swift process supervisor also knows eve: `ServiceMode.eve`, `evePort`, `eveHealthURL` (`/eve/v1/health`), three-service boot (router, eve, web) in Core/LocalServices.swift, Core/ServiceSupervisor.swift, Core/AppVariant.swift:143-157,249, Core/RuntimeInstall.swift:199 (`--exclude /.eve/`). Replacing eve means touching these too (and ~1,600 lines of their tests).

---

## 1. Every eve event the app consumes

### 1.1 Wire shape and reader stamps

NDJSON, one event per line, optional `data:` prefix, `:` comments and `[DONE]` skipped (`EveStream.payload(of:)`, Core/EveStream.swift:659-667).
`EveEvent` (Core/EveStream.swift:546-611) decodes: `type`; `meta.id`, `meta.at`; `data.message`, `data.messageDelta`, `data.turnId`; and the whole `data` as `JSONValue`.
The **reader** stamps (not on the wire): `index` (absolute position, counted per payload line even if undecodable; BackendClient.swift:2388-2406), `sessionId` (2407), `historyRemaining` (2409-2413, from `x-eve-stream-tail-index` header 2355-2359 or a marker).

### 1.2 Event table

All handlers are in `StreamProjection.apply(_:live:)` (Core/EveStream.swift:1742-2432) unless stated. "TR" = `TurnRecord` (per-turn bookkeeping, 1126-1182).

| Event | Fields read | State / UI driven | Cite |
|---|---|---|---|
| `turn.started` | `data.turnId`, `meta.at` | Resumes/creates the current turn; clears `failed`/`failure`/`searchHits`; `activity=.thinking`; `pending=true`; `turnStartedAt` (working row timer). Marks other open turns `superseded`. Late/duplicate starts are ignored by turn-table rules. | 1807-1859 |
| `message.received` | `meta.id`, `data.message` (thread prefix stripped), `data.turnId`, `data.kind` (`execution.background_task` = sub-agent report), `meta.at` | Appends the **owner bubble**, or adopts the optimistic `local-<uuid>` row (text-equal fold, 1983-2008), or rewrites a discarded row (1956-1982), or attaches to held rows (`attachReplay` 2009), or settles sub-agent reports without a bubble (1937-1948). Sets `continuationRowId` if text has the continuation marker (1883). Redelivery guard by `indexById` (1866). Clears `failed`. | 1860-2029 |
| `compaction.requested` | `data.turnId` | `activity=.compacting` ("Compacting the conversation") | 2030-2033 |
| `compaction.completed` | `meta.id`, `meta.at`, `data.turnId` | Appends `CompactionMark` (quiet note row "Conversation compacted to fit the model's window", anchored under the last message) | 2034-2044; row Core/Transcript.swift:140-142,155-157 |
| `reasoning.appended` / `reasoning.completed` | `data.turnId` only | `activity=.thinking`. Not "work" (a turn that fails after reasoning only still folds). | 2045-2049 |
| `actions.requested` | `data.actions[]`: `toolName`/`subagentName`/`remoteAgentName`/`name`, `callId`, `input` (`command`/`query`/`path`/`url`/`use_case`/`tool`/`message`/`elements`) | `activity=.tool(name, detail)` (detail = first 60 chars, shell cut to program+subcommand 891-899); marks work (folds retried failures); records sub-agent brief by `callId` (2058-2063); **widgets**: any tool `<connectionId>__create_view` or with `input.elements` becomes `LiveWidget(id=callId prefix 80)` (parseLiveWidgets 2509-2536) | 2050-2081 |
| `action.input.appended` | `data.toolName` | `activity=.tool(name)` unless already the same tool (keeps detail) | 2082-2089 |
| `message.appended` | `meta.id`, `data.messageDelta`, `data.turnId`, `meta.at` | Streams text into the **assistant bubble** (first delta creates the row, id = event id; later deltas append). `activity=.working` ("Writing"). Replay-of-held-block suppression (2106-2119). Marks the first reply row of a sub-agent report turn (`taskReplyRowIds`). | 2090-2148 |
| `message.completed` | `meta.id`, `data.message`, `data.turnId`, `meta.at`; child tracker also `data.finishReason == "stop"` (Core/SubagentCard.swift:76) | Authoritative text rewrite of the bubble (or inserts one). Closes the open block. Blank/`<think>`-only replies render nothing (Core/Transcript.swift:172-175). | 2149-2201 |
| `turn.failed`, `session.failed` | `data.code`, `data.message`, `data.turnId`, `meta.id`, `meta.at` | Live turn: `pending=false`, `failed=true`, `failure=TurnFailure(code, detail)`; `discardMessage` (folds the owner row eve rolled back, 1372-1388); appends a `FailureMark` (failure row with Retry) (1398-1419). `session.failed` additionally clears `questions`, `pendingRequests`, `runningTasks`, held rows and abandons sub-agent runs (2249-2256). Stepped-off turn: only a row, no banner (2210-2241). `turn.failed` also `settleReplay` (2203). | 2202-2276 |
| `action.result`, `action.partial` | `data.result.output.{status,taskId,agentId}`, `data.result.callId` (sub-agent admission); whole `data` for search chips (`parseSearchChips`, 810-847: array / `{results}` / `{result:{results}}` / `{output:{results}}`, 5 http(s) non-local rows) | `searchHits` (chips under transcript, `SearchChipsRow` ChatView.swift:1968); `activity=.thinking` on `action.result`; marks work. Sub-agent: `runningTasks[task]`, `noteLaunch`. **No tool-name check**: any result shaped like search results yields chips. | 2277-2297 |
| `subagent.completed` | `data.backgroundTask.{taskId,status=="working"}`, `data.output` (JSON string with `agentId`), `data.callId` | Admission receipt (not a completion): `noteLaunch` creates/updates a `SubagentRun` | 2298-2307 |
| `subagent.called` | `data.agentId`, `data.childSessionId`; reader `index` + `sessionId` | `childSessions[agent]`, `childCalls[agent]` = `SubagentCallSite`; used to open/cancel the child stream through the parent | 2308-2320 |
| `step.started` | `data.turnId` | `TR.sawStep=true` only (used by `markQueued`). Does not change `activity`. (Child tracker: `activity=.thinking`, Core/SubagentCard.swift:63-64.) | 2321-2325 |
| `input.requested` | `data.requests[]`: `kind`, `requestId`, `prompt`, `options[{id,label,description,style}]`, `allowFreeform` | `kind=="question"` -> `OwnerQuestion` card (`parseQuestions` 2483-2505); every other kind -> `PendingRequest` (SubagentRuns.swift:215-237, "waiting" card). A question counts as work and closes rows above it. A question journaled before the newest turn start is not shown (2361). | 2326-2368 |
| `input.resolved` | `data.resolutions[]`: `requestId`, `kind`, `response.optionId` | Removes matching question/pending request. `kind=="session-limit"` + `optionId=="stop"` -> `dropHeldMessages` (rows eve will never replay). Otherwise, with no requests left: origin rows dropped, `replayOpen=true`. | 2369-2390 |
| `turn.completed` | `data.turnId` | `pending=false`; clears `discardedUserMessageId`; `foldRetriedFailures` (an answer clears the failure it retried); `markQueued` | 2391-2428 |
| `turn.cancelled` | `data.turnId` | `pending=false` (Stop). Reader treats as terminal. | 2391-2428 |
| `session.waiting` | `data.turnId` | `pending=false` but does not clear `discardedUserMessageId` | 2391-2428 |
| `session.completed` | none | `pending=false`; drops held rows if no request is open | 2393 |
| `session.cancelled` | none | **Not handled by the projection.** Only the reader (BackendClient.swift:2450-2451) treats it as a terminal for arming/finish. | - |
| (anything else) | - | ignored (2429) | |

Consumers outside the projection:
- Follower loop: `turn.failed`/`session.failed` -> `recordSendError` (AppModel.swift:1524-1531); `turn.started`/`turn.completed`/`turn.cancelled` clear the error (1532-1539); `restingEvents` (turn.completed, turn.cancelled, turn.failed, session.waiting) schedule a snapshot (4963-4965, 1541).
- `guardStoppedReport` reads `message.received` text to auto-cancel a turn that only reports owner-stopped sub-agents (AppModel.swift:2454-2467; Core/SubagentCard.swift:533-560).
- `ReplayGate.LiveTurn`: starts = `turn.started`, `message.received`; ends = `turn.completed`, `turn.cancelled`, `turn.failed`, `session.completed`, `session.failed`, `session.waiting` (Core/ReplayGate.swift:74-78).
- `ChildTracker` (Core/SubagentCard.swift:48-94) folds a child session's stream: `turn.started`, `message.received`, `reasoning.*`, `action.result`, `step.started`, `actions.requested`, `message.appended`, `compaction.requested`, `message.completed` (+`finishReason`), `turn.completed`, `turn.failed`, `session.failed`, `turn.cancelled`.
- `isWork` (Core/EveStream.swift:1345-1356) decides "turn got further than the message": `actions.requested`, `action.result`, `action.partial`, `input.requested`, non-empty `message.appended`/`message.completed`.

### 1.3 Response/header contract the reader depends on

- `GET .../stream?startIndex=N` (N >= 0 absolute; negative = from tail), `&includeTailIndex=1` -> header `x-eve-stream-tail-index` (index of last recorded event, -1 empty) (BackendClient.swift:2289-2294, 2355-2359).
- Child stream: `&parent=<sessionId>&at=<index of parent's subagent.called>` (2298-2303).
- Send: eve answers 202 (2522 comment).
- Errors relayed by the proxy: 409 `{code:"session_not_active"}` -> `sessionEnded`; 409 `session_moved`; 409 `model_selection_unavailable`; 409 `provider_route_retired` (+message); 400 `model_no_vision` (BackendClient.swift:1575-1608, 1636-1640).

---

## 2. HTTP calls

Auth: every request goes through `perform` (BackendClient.swift:679-702) with `ub_session` cookie header and `x-ub-csrf` on writes; a 401/403 triggers one single-flight re-sign-in.

### 2.1 `/eve/v1/*`

| Method | Path | Purpose | Cite |
|---|---|---|---|
| POST | `/eve/v1/session` | Start a session with the first turn. Body `{message (string, or [{type:text},{type:file,data,mediaType,filename}] when images), botId, continueFrom?, retry?}`. Returns `{sessionId}`. | BackendClient.swift:1548-1617 (path 1561) |
| POST | `/eve/v1/session/{id}` | Next turn: same body without `continueFrom`. | same |
| POST | `/eve/v1/session/{id}` | Answer an input request: `{botId, inputResponses:[{requestId, optionId}]}` | 1622-1642 |
| GET | `/eve/v1/session/{id}/stream?startIndex&includeTailIndex&parent&at` | Event stream (replay + live) | 2221-2518 (url 2289) |
| GET | `/eve/v1/session/{id}/stream?startIndex=-1` | Newest-event-id probe, 0.8 s budget, one re-auth | 2146-2193 (url 2161) |
| POST | `/eve/v1/session/{id}/cancel[?scope=report]` | Stop the turn; `scope=report` retires only the stopped-report cards | 1242-1253 |
| POST | `/eve/v1/session/{childId}/cancel?parent&at[&agentId]` | Stop a sub-agent via its parent's `subagent.called` index | 1258-1279 |
| GET | `/eve/v1/health` | Supervisor probe only (not BackendClient) | Core/AppVariant.swift:157; Core/LocalServices.swift:217,428 |

### 2.2 `/api/*` (all in Core/BackendClient.swift unless noted)

| Method | Path | Purpose | Line |
|---|---|---|---|
| POST | `/api/auth/session` | Device-token sign-in (Bearer), returns csrf | 453 |
| GET | `/api/auth/session` | Read csrf back / probe minted session | 490, 512 |
| DELETE | `/api/auth/session` | Sign-out / retire minted session | 576, 594 |
| GET | `/api/health` | Web health (Core/ServerConfig.swift:55) | - |
| GET | `/api/shell` | ShellStore: bots, sections, recents, selection | 748 |
| PUT | `/api/shell` | Shell actions (`ShellActions`), `touchChat` (session pointer + preview), proposal confirm/dismiss | 1673, 1724, 1963 |
| GET | `/api/agent/state?botId` | Durable side-channel events + proposals for the bot's thread | 764 |
| POST | `/api/agent/tick?limit=2` | Handoff pump; returns `workingBotIds` | 1484 |
| GET | `/api/status` | Operator + build info (`eve` readiness field) | 785 |
| GET | `/api/approvals` | Pending approvals (polled 1.5 s) | 797 |
| POST | `/api/approvals/{id}` | `{decision: approve|deny, actionSha256}` | 809 |
| GET / PUT / DELETE | `/api/providers` | Provider catalogue, connect, active, roles, per-bot composer chip (`?botId`), `updateComposer` PUT `{botId, modelId, effort, speed}` | 825, 855, 922, 1017, 1464, 1989 |
| POST / POST / DELETE | `/api/providers/oauth`, `/api/providers/oauth/{pollId}` | Device/browser OAuth start, poll, cancel | 957, 987, 1006 |
| GET / PUT / POST / DELETE | `/api/connectors` | Composio catalogue, key, authorize, revoke | 1043, 1138 |
| GET | `/api/connectors/tools?toolkit` | Tools of one app | 1067 |
| GET / POST | `/api/connectors/own-app` | Own OAuth app form / submit | 1106, 1128 |
| GET / POST / DELETE | `/api/connections` | Direct MCP/OpenAPI connections, refresh, reauthorize, remove | 1159, 1171, 1182, 1192 |
| GET / PUT | `/api/usage` | Token traffic, daily budgets | 1198, 1221 |
| GET / POST | `/api/routines?botId` | List / create routines | 1286, 1316 |
| PATCH / DELETE | `/api/routines/{id}` | Update / delete | 1349, 1367 |
| POST | `/api/routines/{id}/run` | Manual run | 1381 |
| GET / DELETE | `/api/memory?botId[&id]` | Memory notes | 1393, 1418, 1434 |
| GET | `/api/bots/context?botId` | Instruction cost/default | 1447 |
| GET / POST | `/api/workspace` | Folder recents, add/remove project | 1506, 1527 |
| POST | `/api/agent/widget` | Persist a live widget `{botId, callId, data:{toolName, arguments}}` | 1753 |
| GET | `/api/connections/widget/{id}` | Saved drawing host page | 1776 |
| POST | `/api/connections/widget/{id}/call` | Drawing's own tool call | 1939 |
| GET | `/api/agent/image/{id}` | Generated image bytes | 1790, 1806 |
| POST | `/api/agent/image/{id}/regenerate` | Redraw lost image | 1878 |
| GET / POST / DELETE | `/api/agent/media[/{id}]` | Library list, item, relink, forget | 1827, 1848, 1862, 1924 |
| POST | `/api/attachments` | Multipart upload for the composer | 2047 |

**Eve-coupled (must change or go):** all of 2.1; `PUT /api/shell` `touchChat`/`setSession`/`clearThread`/`openRecent` (session-pointer actions, ShellActions.swift:35-43,62-64); `GET /api/agent/state` (durable half of the merge); `POST /api/agent/tick` (handoff pump); `GET /api/status` field `eve`; `GET/PUT /api/providers?botId` (per-bot model, see §5).

---

## 3. Transcript model

### 3.1 Pipeline

```
eve stream --> StreamProjection (messages, failureMarks, compactionMarks, widgets, questions,
               pendingRequests, subagentRuns, searchHits, activity ...)         [Core/EveStream.swift]
GET /api/agent/state --> [AgentEvent] (durable)                                  [Core/BackendModels.swift:231]
        \                     /
         Transcript.merge  --> [TranscriptRow]            [Core/Transcript.swift:77]  (+ live widgets, group attribution: AppModel.swift:3084-3103)
         TranscriptBlocks.build --> [TranscriptBlock]     [Core/TranscriptBlocks.swift:50]
         window()  --> transcriptWindow                   [TranscriptBlocks.swift:219, AppModel.swift:3029]
         ChatView renders blocks; sub-agent cards sit under anchor rows (ChatView.swift:601-616, 739-748)
```
`publishTranscript` throttles rebuilds to 100 ms with a trailing edge (AppModel.swift:3061-3082). `rebuildTranscript` (3084-3134) only publishes when rows/blocks differ and caches per bot.

### 3.2 Row kinds (`TranscriptRow.Kind`, Core/Transcript.swift:4-11) and who builds them

| Kind | Built from | Eve-specific? |
|---|---|---|
| `user` | `message.received` -> `ChatMessage(.user)`; paired with durable user rows by text (Transcript.swift:119-120,167) | pairing/folding is eve+split-store specific |
| `assistant` | `message.appended`/`message.completed`; `<think>` prefix stripped (`withoutLeadingThink`, EveStream.swift:760-803) | `<think>` strip needed only if router emits inline think |
| `failure` | `FailureMark` (EveStream.swift:469-486), id `failure-<id>`, anchored under the failed turn's last row; Retry only on `retryableMarkId` (947). Rendered by `FailureRow` (ChatView.swift:1235-1310) | row itself: any engine. Anchoring/fold: eve |
| `unsent` (+ the owner bubble) | `UnsentMessage` list on disk (Core/UnsentMessages.swift), placed by `placeUnsent` (Transcript.swift:195-232) | any engine (client-held refused sends) |
| `note` (compaction) | `CompactionMark` | any engine that compacts |
| `note`, `handoff`, `post` | durable `AgentEvent.kind` (not on the stream) | multi-bot |
| `widget` | durable `widget` event; live: `LiveWidget` from `actions.requested`, row `live-<callId>` (AppModel.swift:3097-3099), persisted via `POST /api/agent/widget` with retries (AppModel.swift:2942-2979) | any engine with MCP-app tools |
| `image` | durable `image` event (`imageId`), fetched from `/api/agent/image/{id}` | any |
| `page` | durable `page` event (Library item) | any |
| working row | not a row: `WorkingRow` driven by `activity`, `activitySince`, `runtime model note` (ChatView.swift:755-770) | any |
| sub-agent card | not a row: `SubagentGroupCard` placed under anchor row (ChatView.swift:739-748) | eve sub-agents only |
| queued tag / "never got this message" | `QueuedTag` under owner bubble (ChatView.swift:1774), `FailureRow` w/ "Send again" (715-725) | eve only |
| "Continued from an earlier session" divider | `continuationRowId` (ChatView.swift:670-674) | eve+proxy only |

`TranscriptBlock` (TranscriptBlocks.swift:10-43): `dayDivider`, `message`, `summary` ("N messages with <bots>", multi-bot), `images` (adjacent pictures grouped).
Helpers: `continuationIds` (stacking), `latestReplyRunIds` (scroll anchor), `window` (60 blocks / 20k chars) (all any-engine).

### 3.3 Replay, ReplayGate, snapshots, cursor resume

- **Open a chat** (`performReload`, AppModel.swift:1128-1455): in parallel `GET /api/agent/state` and `newestEventId` probe (1140-1144). Then either **resume** from a snapshot (read from `cursor-1` to the marker, `markHistory:true`; anchor check on `resume.lastEventId`, 1169-1229) or **replay from zero** into a *second* `StreamProjection` swapped in when it holds as many rows (1231-1360). `ReplayGate` decides when the replay reached the live tail (below) so history is applied silently and only the live tail publishes. After load: `followSession` loops `client.stream(startIndex: followCursor.next)` with 2 s backoff while no local send is pending (1473-1559).
- **`ReplayGate`** (Core/ReplayGate.swift, 128 lines): `Durable.tailId/tailAt/ids/hasStamps`; `reachedLiveTail` (id equals durable tail, or stamp >= tail stamp, or unknown id on unstamped store); `LiveTurn` (running/novelStart from start/end events); `mayShowWorking(historyRemaining, drained, novelStart)`: server-stated `historyRemaining <= 0` wins, else "burst went quiet for 0.35 s" (`replayBurstGap`, AppModel.swift:597) or "id the durable store never wrote". It exists because chat rows are not in the durable store (a history replay looks like a live turn) and because eve gives no live/history boundary except the tail header.
- **Snapshots** (Core/ChatSnapshot.swift, AppModel.swift:4843-5216): per-bot JSON in `~/Library/Caches/.../chat-snapshots`, holds the Codable `StreamProjection`, durable events, `cursor`, `lastEventId`, `seenTurnIds`, `localTurnIds`. Only written for chats at rest (`openChatSnapshot` 4970-4992). Trust key: `formatVersion` (11, ChatSnapshot.swift:21; every stored-field change must bump it, enforced by `ChatSnapshotTests`) + `UBSnapshotLogic` hash of UsefulBotCore+AppModel sources stamped by `build-app.sh:232` (AppModel.swift:525-530) + 7-day max age. Prewarm builds snapshots for unopened chats after launch (5069-5191). Exists to dodge eve's whole-session chunk scan (12,554 events, 4-7 s; ChatSnapshot.swift:5-14).
- **History marker / tail**: `newestEventId` (negative `startIndex`, 1 chunk file) and `includeTailIndex` header; `HistorySnapshot` before each send (BackendClient.swift:2087-2136).

### 3.4 Send, retry, fold, retire

Send (`send`, AppModel.swift:2053-2438): optimistic row `local-<uuid>` appended via a synthesized `message.received` (2129-2137) -> `historySnapshot` of the session (turn ids, `streamStart`) (2181-2208) -> `POST` (2218-2251) -> `touchChat` (2280) -> **armed stream**: `client.stream(expectedSuffix: echo, historyTurnIds, startIndex)` ignores everything until a `message.received` with matching text and an unseen `turnId`, then yields to terminal (BackendClient.swift:2414-2457) -> `applyLiveEvent` (AppModel.swift:2775). Failure after POST: `recordSendError(resendable:false)`; before POST: `UnsentMessage` bubble + note (2366-2421).

**Retry** (`retryLastTurn`, 1817-1841): only if `SendFailure.mayResend` (EveStream.swift:539-542; tests RetryGateTests) and the last owner text is resendable (1848-1854: no `[file: ]` lines, not a handoff envelope). A `historyBroken` failure (EveStream.swift:232-235, "tool result is missing") sends into a **fresh session** with `continueFrom` (1840). Router cool-down gates Retry (`failureRetryUntil`, 3136-3162).

**Fold/discard logic** (all because eve rolls a failed turn's user message back out of the session, so a replay would show it once while the client showed it twice):
`discardMessage` 1372-1388, `markFailure` 1398-1419, `foldRetriedFailures` 1434-1451, `adoptLastUserRow` 1505-1518, the `discardedUserMessageId` branch in `message.received` 1956-1982, `claimUserRow` 1332-1341, `TR.openUserRows/carriedUserMessageId/producedWork/sawMessage` (1126-1182).

**Retire / 409** (all because eve ends a session for good after a failure): `BackendError.sessionEnded` from 409 `session_not_active` (BackendClient.swift:1575-1581, 1636-1640) -> `postSession` again with `sessionId:nil, continueFrom:old` (AppModel.swift:2226-2251); `sessionMoved` (BackendClient.swift:1584-1588; AppModel 2423-2427 re-polls shell); `session.failed` clears questions/requests/held rows/runs (EveStream.swift:2218-2225, 2249-2256); `answerRequest` on 409 hides the card and drops held rows (AppModel.swift:3355-3371); stale `FailureMark` copy for broken history/`messages_count` (EveStream.swift:358-360, 392-394).

### 3.5 Which parts exist only because of eve vs. any engine

**Eve-only (go with eve, or become trivial under a per-turn protocol with ids and journal order):**
1. Whole-session stream with replay: `ReplayGate`; `HistorySnapshot`/`historySnapshot`; armed-stream matching by text (`expectedSuffix`/`historyTurnIds`/`allowUntaggedTurn`); `seenTurnIds`, `localTurnIds`, `tailUnreported`, `streamStart`; `newestEventId`; `includeTailIndex`; `markHistory`/`historyMarker`; `historyRemaining`.
2. Per-turn out-of-order bookkeeping: `TurnRecord`, `turns`/`turnOrder` (cap 256), `currentTurnId`, `superseded`, `isBackfill`/`newestTurnStart`, `journalSession`/`journalBase`/`journalTop`/`firstSession` (turn ids and positions restart per session: `turn_0`), session-prefixed turn ids (EveStream.swift:1779-1781), `groupAnchors`, `stash`/`unstash`, `turnOwner`. Reason: send's armed stream skips `turn.started`; follower can rewind past the 2,000-id dedupe cache (`seenCap`); failures can arrive after the owner resent.
3. Fold/discard of failed turn messages (3.4 above) and `FailureMark` re-anchoring (`reanchorFailures` 1421-1428).
4. Held/queued/dropped: `queuedMessageIds`, `droppedMessageIds`, `heldOrder`, `heldOrigins`, `replayOpen`, `replayTurn`, `markQueued` (1617-1629), `dropHeldMessages` (1633-1640), `attachReplay` (1654-1697), `settleReplay`, `cutReplayedOwnerText` (1562-1575), `replayKey`; UI `QueuedTag`, "never got this message" row, `resendDropped` (AppModel.swift:3394-3400), `resentRowIds`/`droppedMessageForRow` (3311-3332). Reason: eve parks owner messages behind an open input request and replays them joined by blank lines when answered.
5. Batched sub-agent delivery: `taskReportPattern` regex on eve's wording (EveStream.swift:717-720), `taskReports`, `settleReports`, `runningTasks`, `settledTasks`, `callBriefs`, `callTurns`, `taskAgents`, `childSessions`, `childCalls`, `noteLaunch`, `abandonRuns`, `taskReplyRowIds`; `StoppedRunGuard` (eve's built-in `agent` tool cannot be overridden, Core/SubagentCard.swift:528-560); `SubagentStatus.notDelivered`/`awaitingReport`/`undeliveredAfter` (eve holds reports until siblings settle, :186-216); child-stream following through the parent (AppModel.swift:3402-3576). Whole feature is dropped with sub-agents.
6. Retired-session recovery: items in 3.4 "Retire / 409", `continueFrom` brief, `isContinuationTurn` + `continuationMarker` (EveStream.swift:685-693), `continuationRowId`, divider row, `FailureMark` copy for `historyBroken`.
7. Proxy-injected text: `stripThreadPrefix` + `botTurnPrefix`/`groupTurnPrefix`/`sessionNotePrefix` (EveStream.swift:669-682, 746-754), `isHandoffEnvelope` (697-707), `backgroundTaskKind` patched into eve (711). Only needed while the proxy writes identity prefixes into the stored user turn.
8. Echo reconciliation: `[file: name (type)]` lines (`Attachments.echoedMessage` Core/Attachments.swift:95-103, `namesEchoedFile`, `sentImages`), `optimisticUserPrefix` text-equality fold (1983-2008). Fixed by echoing a client message id and structured attachments.
9. Durable/live merge by text counts (Transcript.swift:119-123,164-173): exists because the transcript is split across two stores.
10. `ChatMessage` journal ordering (`rowJournal`, `insertMessage`, 1090, 1225-1244) for backfilled turns.

**Any engine needs:**
- Optimistic owner row + authoritative echo (but by id).
- Delta accumulation and an authoritative completed text; bubble ids stable across deltas/completion.
- Working row: activity label + whole-turn timer (`turnStartedAt`/`activitySince`), model-at-send note (`runningModelLabels`, AppModel.swift:164,2088,1789).
- Failure row anchored under the turn, newest-only live Retry, cool-down countdown, per-code copy (`TurnFailure.reason`, EveStream.swift:307-439; router codes `circuit_open`, `upstream_*`, `budget_exhausted`, `model_selection_unavailable` etc. come from the router, not eve; `session_busy`, `ended without a finish reason`, `cannot connect to api`, `empty-model-response`, `messages_count` are eve/provider-relayed).
- Unsent (refused-before-engine) bubble, disk persistence (Core/UnsentMessages.swift), Edit/Retry/Dismiss (AppModel.swift:1856-2046).
- Widgets (live + persist), search chips, questions, generic pending-request card, compaction note.
- Stop (cancel), per-bot background turns (rail pulse, notifications), `replyReady`, `railHops`.
- Fast open of long chats (perf guard `perf:check` budgets): needs either a snapshot+resume or a server-side materialised view.
- Day dividers, windowing (60 blocks / 20k chars / slim first paint 14 blocks), image runs, 100 ms publish throttle.

---

## 4. Approvals and questions UI

**Tool approvals** (not eve events): `approvals: [ApprovalItem]` (AppModel.swift:172) filled by the 1.5 s poll (954-975; ids decided locally stay hidden until the server drops them, 967-973). `ChatView.askColumn` (ChatView.swift:224-275) docks cards between transcript and composer; `approvalAsk` (277-334) shows "Needs approval", tool name, `originLabel` ("Sub-agent of X, from another chat" / other bot's name; BackendModels.swift:456-465), preview (6 lines), **Deny** / **Approve** (`approval-deny`/`approval-approve`). `decideApproval` (AppModel.swift:3602-3626): requires non-empty `actionSha256`, `busyApprovals` guard, `POST /api/approvals/{id}`, removes the card, 1.5 s poll reconciles. Approvals are keyed to `rootSessionId`/`sessionId` and `botId` server-side (web/app/api/approvals/route.ts:24-31), so a different bot's approval can appear in the open chat with a name label.

**ask_question card**: `OwnerQuestion {id=requestId, prompt, options[{id,label,detail}], allowFreeform}` (EveStream.swift:2436-2461) published as `openQuestions` (AppModel.swift:2981-2983). `questionAsk` (ChatView.swift:338-387) "\<bot\> asks" + prompt + one button per option; no options or `allowFreeform` -> "Reply below to answer." Buttons disabled while `model.pending`. **Answer = an ordinary owner message** with the option label (`answerQuestion`, AppModel.swift:2988-2991 -> `send(option.label)`); eve settles the open question with `input.resolved` on the next turn. `beginTurn` and `send` clear `questions` immediately (EveStream.swift:1716) because eve files `input.resolved` before the new user message where the send's reader never looks. Session failure clears them (2219, 2250).

**Waiting card** (`PendingRequest`, any non-question `input.requested`: session-limit, unknown): `WaitingCard` (App/SubagentCard.swift:444-508, amber, "\<bot\> is waiting on you"); copy for `session-limit` ("This chat used its token budget. Continue ... or stop here.", options Continue/Stop) in `PendingRequestCopy` (Core/SubagentCard.swift:433-456). **Answer = `inputResponses`** to the session route, not a message (`answerRequest`, AppModel.swift:3341-3378, `BackendClient.answerInput` 1622-1642); card leaves when `input.resolved` arrives; buttons come back after 15 s if it does not. A request with no options offers Dismiss (local hide, `dismissedRequestIds` 3381-3384). While a request is open, owner sends are queued by eve (held/queued rows).

**Proposals** (bot asks to create/modify/connect; durable store + shell actions): `Proposal` (Core/Proposal.swift), `ProposalCardView` (App/ProposalCardView.swift:5-456), confirmed with `PUT /api/shell {action, proposalId, proposalStatus}` (AppModel.swift:5266-5358), connect cards poll through waiting/connected/failed (Proposal.swift:24-31, 168-178). Kinds: `createBot`, `createGroup`, `updateBotProfile`, `fanout` (multi-bot) and `connectApp`, `connectServer` (keep).

---

## 5. Multi-bot UI surface and classification

Classification key: KEEP = engine/bot-count independent. SIMPLIFY = survives, loses multi-bot/eve branches. REMOVE = deleted with sub-agents/many-bots. ADAPT = same job, new protocol underneath.

### 5.1 What the multi-bot model consists of

- **Data**: `ShellBot` (BackendModels.swift:6-76) with `kind` ("bot"|"group"), `memberIds`, `sectionId`, `pinned`, `hidden`, `notify`, `sessionId` (the eve pointer), `permission`, `workspace`, avatar fields; `ShellSection` (163-178); `ShellRecent` (180-199); `ShellStore` (201-229).
- **Default/orchestrator**: `Threads.defaultBotId = "bot-useful"` (Core/Threads.swift:25), orchestrator rule (37-43), group members max 6/min 2 (22-24). Group replies are credited to the orchestrator (`Transcript.attributeGroupReplies` Transcript.swift:283-296; AppModel.swift:3100-3103). `@mention` parsing (Threads.swift:62-124) has no caller in the app, only tests (the composer still says "@name to direct one bot", ComposerView.swift:90; the server routes the mention).
- **Rail**: pinned grid, sections, "Unassigned", "Hidden", per-row menu (pin/move/rename/hide/delete/new section), face per bot with pose from `railActivity`, "WAITING ON YOU"/"SUB-AGENTS WORKING"/"REPLY READY" subtitles (RailView.swift:720-733), hop on reply (`railHops`), account row.
- **Per-bot background runtime**: `sendTasks[botId]`, `sendGenerations`, `chatGenerations`, `inflightSessions`, `backgroundProjections`, `transcriptCache`, `stashSnapshots`, `cacheUse`+`CacheBudget` (16 MB, AppModel.swift:481, 5193-5216), `workingBotIds`, `handoffWorkingIds`, `backgroundActivities`, `replyReady`, `waitingBotIds`, `subagentWorkingBotIds`, `sendErrors`, `unsentLists`, `unsentDrafts`, `windowStarts`, `replyQuotes`; prewarm of every bot's snapshot (5069-5129); 10-bot concurrency copy ("Ten bots are already working", EveStream.swift:369-371).
- **Handoffs/cross-bot**: `AgentEvent.kind handoff/post` -> `BotMetaRow` strips "Messaged X"/"Message from X" (ChatView.swift:1502-1553, 1665-1693), fan-out collapsing and "N messages with ..." summary (TranscriptBlocks.swift:124-141, 81-94), handoff pump (`/api/agent/tick`, AppModel.swift:1689-1734), `fanout` proposal, `sendToBot` shell action (ShellActions.swift:156-163), approval origin label for other bots/sub-agents.
- **Per-bot model**: `/api/providers?botId` returns that bot's `ComposerState` (BackendClient.swift:1462-1476); `ComposerSelection` caches per bot and guards stale reads/saves (BackendModels.swift:377-413; AppModel.swift:158-160, 1759-1793); chip menu `ModeCard`/`ModelFlyout` (App/ComposerView.swift:984-1340). Server refuses sends for a bot whose model is gone (`modelSelectionUnavailable`). Global roles (default/reviewer/image) in Providers pane (AppModel.swift:264-266; ProvidersPaneView.swift:442-444).
- **Threads per bot**: one session pointer per bot (`sessionId`), `clearThread`, `setSession`, `openRecent` (recents shown only in the search palette, PickerViews.swift:229-240; RootView.swift:186), `continueFrom` between sessions.
- **Sub-agents**: runs/batches/cards/progress stores/cancel (see §3.5 item 5).

### 5.2 File table (every Swift source file)

| File | Lines | Class | Notes |
|---|---|---|---|
| App/AppModel.swift | 5853 | REWRITE chat core, KEEP rest | Chat/send/stream/snapshot/sub-agent/request core ~2,800 lines: state 81-250 & 458-690; reload/follow/poll 1004-1760; send/unsent/errors 1795-2530, 2589-2860, 2919-3000; sub-agents/requests 3223-3590; shell + stash/snapshots/prewarm/caches 4498-5262; proposals 5264-5358. Unrelated and KEEP: providers/OAuth 3628-4036 (~410), connectors 4037-4430 (~390), usage 4431-4497, onboarding 5367-5424, memory/routines 5426-5598, attachments/workspace 5600-5788 |
| App/ChatView.swift | 2486 | SIMPLIFY | Remove sub-agent card placement (563-578, 596-624, 738-748, 756-768), summary/handoff/post (731-737, 1502-1553, 1665-1693), group header (427-429), queued/dropped (713-725, 1774), continuation divider (670-674). Keep landing/scroll machinery (large), working row, failure row, ask column |
| App/RailView.swift | 1097 | SIMPLIFY (likely rewrite as 1-2 bot switcher) | pinned grid 159-186, sections 188-306, hidden, row menu `RowMenuPopover` 599-675, `BotRowView` 759-857, `PinnedCardView` 970-1097; account/operator row 308-530 KEEP |
| App/RootView.swift | 1673 | SIMPLIFY | `CreateBotDialog` 609-715, `CreateGroupDialog` 716-825, rename/delete/section prompts (≈200-320), `CreateKind`; Connectors dialog 826-1673 (~850) KEEP |
| App/PickerViews.swift | 542 | SIMPLIFY/REMOVE | `NewChatPickerView` 5-179 (create bot/group/pick bot) REMOVE; `SearchPaletteView` 180-542 keep, drop bots/groups/recents sections |
| App/ProposalCardView.swift | 492 | SIMPLIFY | keep `connectApp`/`connectServer` (120-270); remove createBot/createGroup/updateBotProfile/fanout (22-119); `OnboardingCardView` 458-492 (blank-bot form) decide |
| App/SettingsPaneView.swift | 584 | SIMPLIFY | `GroupSettingsFields` 460-584 REMOVE; profile/instructions/routines/memory/notify KEEP |
| App/ChatDetailsPaneView.swift | 786 | SIMPLIFY | group members 75-118 REMOVE; routines list/editor 149-786 KEEP |
| App/SubagentCard.swift | 522 | REMOVE (move `WaitingCard` 444-508 elsewhere; `QueuedTag` 511-522 removed) | |
| App/AvatarStackView.swift | 66 | REMOVE | group faces; `groupMemberBots` helper |
| App/ComposerView.swift | 1423 | SIMPLIFY | group placeholder (90) and `ReplyQuote.wrap(group:)` (AppModel.swift:5821); model chip/flyout KEEP |
| App/PerfHarness.swift | 356 | ADAPT | drives AppModel landing, snapshot marks |
| App/AppSettingsView.swift | 1197 | KEEP | reviewer-role row is a decision (reviewer = second model; Core activity label "Asking the reviewer") |
| App/ProvidersPaneView.swift | 1026 | KEEP | |
| App/FirstRunView.swift | 1573 | KEEP | |
| App/BotFaceLayer.swift 362, NativeAvatar 113, OperatorAvatar 142, AppLogoView 110, BrandAssets 148 | - | KEEP | faces/avatars per bot (1-2 bots still have faces) |
| App/ChatMarkdownView 404, ComposerTextView 284, GeneratedImageRow 417, PageRow 349, WidgetWebView 448, ExcalidrawPreview 196, SentImages 188, LibraryView 809, MemorySectionView 239, InstructionsEditor 363 | - | KEEP | |
| App/NativeControls 493, NativeTheme 487, OutsideClick 221, WindowChrome 106, ProviderMark 158, MoveToApplications 410, Updater 207, LaunchCheck 36, TurnNotifier 95, UsefulBotApp 55 | - | KEEP | |
| Core/EveStream.swift | 2537 | REWRITE (split) | see §6 |
| Core/BackendClient.swift | 2579 | ADAPT | eve section ~600 lines rewrite; auth/providers/connectors/etc KEEP |
| Core/BackendModels.swift | 1356 | ADAPT/SIMPLIFY | `ShellBot.kind/memberIds`, `ShellStore.sections/recents`, `AgentEvent.handoffId/proposalId`, `ApprovalItem.subagent/rootSessionId/originLabel`; providers/connectors/usage KEEP |
| Core/SubagentRuns.swift | 238 | REMOVE (move `PendingRequest` 122-148 and `parsePendingRequests` 212-237) | |
| Core/SubagentCard.swift | 560 | REMOVE (keep `PendingRequestCopy` 433-456, `Transcript.rowId(forMessage:)` 458-470 if rows stay) | |
| Core/ReplayGate.swift | 128 | REMOVE/REPLACE | |
| Core/ChatSnapshot.swift | 201 | ADAPT or REMOVE | depends on protocol (§6) |
| Core/Transcript.swift | 316 | ADAPT | drop handoff envelope hide (170), group attribution (279-296), durable/live text pairing if single store |
| Core/TranscriptBlocks.swift | 464 | SIMPLIFY | drop `summary`, handoff collapse (124-141), `latestReplyRunIds` task replies; keep dividers, images, window, date parsing |
| Core/Threads.swift | 138 | REMOVE (keep `defaultBotId` constant if a default bot remains) | `parseMentions` (62-124) has no caller in the app (tests only). `defaultBotId` ("bot-useful") is also read by Core/FacePalette.swift:65, App/FirstRunView.swift:187, App/InstructionsEditor.swift:43, App/SettingsPaneView.swift:256-257,473, App/RootView.swift:726, App/AppModel.swift:5381 |
| Core/ChatAttribution.swift | 44 | REMOVE | cross-bot faces/labels |
| Core/Proposal.swift | 210 | SIMPLIFY | keep connect kinds |
| Core/ShellActions.swift | 174 | SIMPLIFY | drop group, fanout, section, move, recents, setSession |
| Core/UnsentMessages.swift | 213 | KEEP | engine-neutral; reword "before eve took" |
| Core/ChatInline.swift | 269 | KEEP | markdown inline parser |
| Core/Routines.swift | 302 | KEEP | |
| Core/LocalServices 1323, ServiceSupervisor 144, AppVariant 296, RuntimeInstall 297, HealthPoller 50, ServerConfig 57, PhoneReadiness 119 | - | ADAPT | remove `ServiceMode.eve` and eve port/health/ownership logic |
| Core/BotFaceMotion 101 (`BotFacePose(activity:)` takes `TurnActivity`), BotFaceGeometry 249, FacePalette 75 | - | KEEP | `TurnActivity` must survive or `BotFacePose` re-keys |
| Core/RailClock 50, RailCopy 19, RowActionsVisibility 33 | - | SIMPLIFY | rail-only |
| Core/Attachments 183 | - | ADAPT | `[file: ]` echo helpers go; upload/limits stay |
| Core/ComposerDraft 54, ConnectorTile 116, DesignTokens 295, BudgetInput 172, CacheBudget 36, CanonicalOrigin 53, DeviceTokenStore 83, EndpointPolicy 27, Feedback 166, FirstRunGate 56, LocalHost 179, AppPlacement 182, BrandMotion 64, PairingPayload 115, PairingStore 194, PhoneKeychainStore 110, ServerEndpoint 13, SettingsPaneSupport 129, TailnetEndpointPolicy 79, WidgetSaveRetry 57, ChatMarkdown 426 | - | KEEP | `CacheBudget` shrinks with 1-2 bots |

---

## 6. Proposed minimal protocol and Swift file disposition

### 6.1 What the UI actually needs (derived from §1-§4)

Rendered state: owner bubble, assistant bubble(s) per turn, working label+timer, failure row with Retry, compaction note, widgets, search chips, question card, waiting card, queued tag (only if engine queues), unsent bubble (client-held), rail "working/waiting/reply ready", notification on turn end.

Proposed envelope (one chat per bot; **proposal, not a decision**):
`{ seq: Int (per-chat, gapless, monotonic), id: String, at: ISO-8601 ms (always server-stamped), chatId, turnId (globally unique, never reused), type, ... }`

| # | Type | Fields | Replaces / drives |
|---|---|---|---|
| 1 | `stream.ready` | `tailSeq`, `turnRunning: Bool`, `turnId?` | Header `x-eve-stream-tail-index`, `ReplayGate`, `historyRemaining`, marker probe. Sent once on connect; everything with `seq <= tailSeq` is history |
| 2 | `turn.started` | `turnId`, `origin: owner|routine|system` | Always delivered to every subscriber including the sender (kills the armed-stream race and `TurnRecord` late-start cases). `origin` replaces `data.kind == execution.background_task` and handoff envelopes |
| 3 | `message.user` | `id`, `turnId`, `clientId?`, `text`, `attachments:[{name,mediaType,kind}]` | `message.received`. `clientId` echo binds the optimistic row by id (kills text-equality fold, `[file:]` lines, thread-prefix strip) |
| 4 | `message.delta` / `message.final` | `id`, `turnId`, `delta` / `text` | `message.appended` / `message.completed` (one id per assistant bubble) |
| 5 | `activity` | `turnId`, `kind: thinking|tool|compacting`, `tool?`, `detail?` | `reasoning.*`, `actions.requested` (label), `action.input.appended`, `step.started`, `compaction.requested`. Writing state is implied by `message.delta` |
| 6 | `tool.call` | `turnId`, `callId`, `name`, `widget?:{connectionId, toolName, arguments}` | `actions.requested` widget extraction (only calls that draw need full arguments) |
| 7 | `tool.result` | `turnId`, `callId`, `searchResults?:[{title,url,snippet}]` | `action.result` chip parsing (explicit instead of shape-sniffing) |
| 8 | `turn.completed` / `turn.cancelled` | `turnId` | same; `session.waiting`/`session.completed`/`session.cancelled` disappear |
| 9 | `turn.failed` | `turnId`, `code`, `detail`, `retryAfterMs?`, `resetsAt?`, **`messageKept: Bool`** | `turn.failed`/`session.failed`. `messageKept` states whether the engine retained the owner message, replacing `discardMessage`/`foldRetriedFailures`/`discardedUserMessageId`. Structured fields replace regexes over `detail` (`retry_after_ms`, `resets_at=`) |
| 10 | `input.requested` | `requestId`, `kind: question|limit|other`, `prompt`, `options[{id,label,detail,style}]`, `allowFreeform` | same; one handler instead of question vs pending request |
| 11 | `input.resolved` | `requestId`, `optionId?` | same |
| 12 | `compaction.done` | `id` | `compaction.completed` note |
| 13 | `chat.reset` | `reason: engine_restart|history_broken|owner`, `carriedOver: Bool` | replaces `session.failed`+409 `session_not_active`+`continueFrom`+continuation marker/divider. The server owns "start a new engine session"; the client never sees session ids |
| opt | `message.queued` / `message.dropped` | `id` | only if Pi's steer/follow-up queue is exposed and the product wants the tag; otherwise delete queued/dropped UI |

Requests (replace `/eve/v1/*`, hide session ids): `POST /chat/{botId}/turns {clientId, text, attachments, retry}` -> 202 `{turnId}` or typed refusal (`model_selection_unavailable`, `provider_route_retired`+message, `model_no_vision`, `busy`); `POST /chat/{botId}/cancel`; `POST /chat/{botId}/inputs/{requestId} {optionId|text}`; `GET /chat/{botId}/events?after=<seq>|tail=<n>` (NDJSON); `POST /chat/{botId}/reset` (new chat). Removes from shell store: `sessionId`, `touchChat`, `setSession`, `clearThread` pointer semantics.

**Decision the spec must make (drives Swift size):** (a) server-materialised transcript: `GET /chat/{botId}/transcript?before=` returns rows + `tailSeq`, client only folds live events after `tailSeq`. This deletes `ReplayGate`, `ChatSnapshot` + prewarm, `Transcript.merge` pairing, `StreamProjection` fold of history (~2,500+ Swift lines) and gives single-store ordering. Or (b) keep client fold with `seq` resume; then `ChatSnapshot` can stay (re-key on new `formatVersion`) and the projection shrinks to roughly the §6.1 table (est. 300-450 lines vs 1,514). I recommend (a); the perf guard (`perf:check`, `perf/budgets.json`) then needs new baselines.

### 6.2 Disposition (lines)

**Rewrite (new code, old removed):**
- `Core/EveStream.swift` `StreamProjection` + helpers: lines 920-2433 (1,514) -> new `ChatProjection` (~300-450 under (b), ~100 under (a)). Move/keep from the same file: `JSONValue` 1-79, `SearchChip` 81-92, `TurnActivity` 94-206 (drop `.subagent`, prune the 40-entry tool label table 172-205 to Pi tool names), `TurnFailure` 208-464 (keep router/provider copy; drop `historyBroken`, `session_busy` etc. as the new engine dictates), `FailureMark` 466-486, `CompactionMark` 488-508, `SendFailure` 510-543, `ChatMessage` 613-628, `OwnerQuestion`/`LiveWidget` 2435-2477, `parseSearchChips` 810-847, `requestedToolName/Detail` 849-899, `withoutLeadingThink` 756-808 (only if reasoning is inline). Delete: `taskReports` 717-742, prefix regexes/`stripThreadPrefix` 669-754 (if proxy stops injecting), `isContinuationTurn` 685-693, `EveEvent` decoder 546-611 (replace).
- `Core/BackendClient.swift` eve section: `cancel`/`cancelChild` 1238-1279, `send`/`answerInput` 1542-1660, `HistorySnapshot` through `stream` 2083-2518 (~600 lines) -> ~250 for the new endpoints; keep error mapping style.
- `App/AppModel.swift`: ~2,800 lines listed in §5.2 -> expect ~1,200 after (single/dual bot, no sub-agents/stash/prewarm if (a)).

**Adapt (same job, protocol swapped):** `Core/Transcript.swift` (316), `Core/TranscriptBlocks.swift` (464, delete ~120), `Core/BackendModels.swift` (1,356, ~100 lines of multi-bot fields), `Core/Proposal.swift` (210), `Core/ShellActions.swift` (174), `Core/Attachments.swift` (183), `Core/ChatSnapshot.swift` (201, only under (b)), `App/ChatView.swift` (~450 lines of removals), `App/ProposalCardView.swift`, `App/SettingsPaneView.swift`, `App/ChatDetailsPaneView.swift`, `App/RootView.swift`, `App/PickerViews.swift`, `App/RailView.swift`, `App/ComposerView.swift`, `App/PerfHarness.swift`, `Core/LocalServices.swift`, `Core/ServiceSupervisor.swift`, `Core/AppVariant.swift`, `Core/RuntimeInstall.swift`.

**Delete:** `Core/ReplayGate.swift` 128; `Core/SubagentRuns.swift` 238 (move `PendingRequest` ~45 lines); `Core/SubagentCard.swift` 560 (keep ~50); `App/SubagentCard.swift` 522 (keep `WaitingCard` ~65); `Core/Threads.swift` 138; `Core/ChatAttribution.swift` 44; `App/AvatarStackView.swift` 66; (b only: nothing more; (a): + `Core/ChatSnapshot.swift` 201). Total outright deletion about 1,500 Swift source lines, plus the 1,514-line projection replaced, plus ~2,800 AppModel lines rewritten.

---

## 7. Tests in `macos/Tests/UsefulBotCoreTests/` tied to eve semantics

Whole `macos/` Swift (sources + tests) is 53,800 lines. The eve-tied tests below total about 9,000 lines.

### 7.1 Delete (test exists only for eve semantics that disappear)

| File | Lines | Covers |
|---|---|---|
| EveStreamBackfillTests.swift | 278 | journal-order backfill, stepped-off turns, question on backfilled turn |
| EveStreamLateTurnTests.swift | 182 | stepped-off turn late reply/deltas/question, id reuse after row removal |
| EveStreamOrderingTests.swift | 119 | resend before late failure, rewind disarms fold, late `turn.started` |
| EveStreamOrphanRowTests.swift | 45 | fold into a dead send's orphan |
| EveStreamPreEchoTests.swift | 127 | dead pre-echo send, late own start, late echo fold |
| EveStreamSessionRotationTests.swift | 101 | `turn_0` reuse across sessions, fresh-session retry, journal base |
| EveStreamStragglerTests.swift | 95 | straggler terminal/failure/start vs fold gate |
| SubagentCardTests.swift | 712 | child tracker, row status/header copy, follow planner, cancel targets, stopped-report guard, `PendingRequestCopy` (that last bit: move ~20 lines) |
| SubagentRunTests.swift | 703 | receipts, `subagent.called`, report parsing, relaunch, grouping, **queued/dropped/replay of held rows**, session-limit requests (the pending-request decode tests 265-298 are reusable) |
| ReplayGateTests.swift | 210 | live-tail detection, `LiveTurn`, `mayShowWorking` |
| ReplayDuplicateTests.swift | 72 | long-session replay does not duplicate |
| HistoryMarkerTests.swift | 128 | newest-event probe, marker-bounded replay, tail index |
| StreamCursorTests.swift | 47 | per-line index counting, send cursor from tail |
| ThreadsTests.swift | 113 | mentions, orchestrator, group members, group speaker label |
| ChatAttributionTests.swift | 27 | cross-bot face/label fallbacks |

Subtotal about 2,960 lines.

### 7.2 Rewrite or heavily trim

| File | Lines | Keep / change |
|---|---|---|
| EveStreamTests.swift | 875 | Keep ideas: delta/complete accumulation (78-91), stamps (16-62), activity labels (102-171), `TurnFailure.reason` copy tests (199-360: cool-down, provider limits, reset times, history-broken) -> rewrite against new projection/failure type. Drop 362-875 fold/claim tests (`projectionIgnoresReplayedEventIds`, folds, claims, replay-is-not-work, live send turn ids), replace with a handful for `messageKept` and id echo |
| FailureRowTests.swift | 279 | failure anchoring/retry/newest-only/cool-down clamp/snapshot survival -> rewrite on new projection (concept stays) |
| ChatSnapshotTests.swift | 273 | keep only under option (b); format-version pinning test needs the new stored shape |
| OwnerQuestionTests.swift | 82 | rewrite (question open/answer/next-turn; drop session-failed distinctions) |
| RetryGateTests.swift | 60, RetryTargetTests.swift 27 | `SendFailure.mayResend` and `resendableLastMessage` rules: rewrite small |
| ContinuationTests.swift | 71 | session-note prefix, continuation divider, provider refusal, compaction row: keep compaction + refusal, drop prefix/continuation |
| InlineThinkTests.swift | 65 | keep if inline `<think>` still arrives |
| LiveWidgetTests.swift | 48 | adapt to `tool.call.widget` |
| SearchChipsTests.swift | 330 | parser tests (10-145) keep/adapt; projection tests (147-190) rewrite; the rest (approvals/providers/usage/status decode, 194-330) are unrelated and stay |
| TranscriptTests.swift | 260 | drop handoff envelope/group attribution (48-96, 239-250); keep time interleave tests only if durable/live merge survives |
| TranscriptBlocksTests.swift | 374 | drop fan-out/handoff/summary tests (64-225); keep day divider, windowing, continuation stacking |
| ProposalTests.swift | 264 | keep connect-app/server cases (113-260); drop createBot/profile/fanout |
| ShellActionsTests.swift | 162 | drop group/fanout/profile-face cases; keep keychain/pathComponent/connect |
| ModelSwitchingTests.swift | 253 | keep (per-bot composer read/save race, error copy, route-retired sentence); `compaction note` test (225) adapt |
| UnsentMessageTests.swift | 327 | KEEP (engine-neutral) |
| BackendClientAuthTests.swift | 395 | KEEP |

### 7.3 Adapt for service topology (eve process removed)

AppVariantServicesTests.swift 736, LocalServicesTests.swift 286, LocalServicesRecoveryTests.swift 232, ServiceSupervisorTests.swift 129, AppVariantTests.swift 246 (assert `evePort`, `eveHealthURL`, `ServiceMode.eve`, foreign-listener ownership of `node_modules/eve/...`, `neverBound([.router, .eve, .web])`). Replace the three-service expectations with the new set.

### 7.4 Unaffected (no eve semantics)

AppPlacement, AppVariant (except above), Attachments (except `[file:]` echo tests, lines 36-57), BrandMotion, BudgetInputStrict, CacheBudget, ChatAutolink*, ChatMarkdown*, ComposerGroups (this is model-connection groups, not bot groups), ConnectorTile, Connectors, DesignTokens, FacePalette, Feedback, FirstRunGate, LocalHost, PhonePairing, ProcessRunnerReal, ProvidersV2, RailClock, RailCopy, Routines, RowActionsVisibility, ServerConfig, SettingsPane, SetupFailure, WidgetSaveRetry, WorkspaceChip.

## 8. Open decisions to resolve before implementation

1. One chat per bot, or keep "recents" (multiple sessions per bot)? Drives `ShellRecent`, `openRecent`, `touchChat`, session pointer, snapshot keying.
2. Server-materialised transcript (a) or client fold with seq resume (b) (§6.1).
3. Does the proxy keep injecting `You are X. Standing instructions:` into stored user turns? If not, `stripThreadPrefix` and the three regexes go.
4. Does Pi expose a message queue (steer/follow-up)? If not, delete queued/dropped UI (`QueuedTag`, "never got this message", `resendDropped`).
5. Approvals: still a separate file store polled at 1.5 s, or an `input.requested` kind on the new stream? (Swift change small either way: `ApprovalItem` has no stream dependency today.)
6. Reviewer role (global "reviewer" model, `review` tool label) and `Groups`/orchestrator: confirm dropped, then remove `Threads.defaultBotId` special-casing (starter prompts and onboarding card key off it: ChatView.swift:1045, AppModel.swift:5379-5387).
7. Routines/handoff pump: `POST /api/agent/tick` is the only thing driving `handoffWorkingIds` for routine-run turns on non-open bots; with the new stream a per-bot "turn running" push replaces it. Needs a rail-level status feed (not only the open chat's stream).
