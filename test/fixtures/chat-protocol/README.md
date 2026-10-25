# Chat protocol v1 fixtures

The wire contract between the engine (W1, `agent/engine/`) and the macOS client (W4,
`macos/Sources/UsefulBotCore/`), from SPEC 5.12 and 6. The web service proxies these bytes
unchanged. W1's tests assert the engine produces these shapes; W4's tests decode them.
`gen.py` writes every file here; edit it, not the outputs, and rerun `python3 gen.py`.

Field names are camelCase. Times are ISO 8601 UTC strings with milliseconds. Ids are UUID v4
strings unless named otherwise. An absent optional field is left out, never `null`, except where
a type says `|null`.

## Rows (`GET /api/chats/:id/rows`)

Every row: `{rowId, kind, turnId: string|null, at}` plus its kind's fields.

| kind | fields | rowId |
|---|---|---|
| `user` | `text`, `clientId?`, `attachments: [{name, mediaType, size}]`, `queued?: true` (still waiting behind a running turn) | `<turnId>:u` |
| `assistant` | `text`, `searchResults?: [{title, url, snippet}]` (the `web_search` results of the turn up to this message) | `<turnId>:a<n>` |
| `note` | `text`, `source: "routine"|"connect"|"compaction"|"system"` | the `ub.row` key; compaction `compaction:<entryId>` |
| `failure` | `code`, `detail`, `retryAfterMs?`, `resetsAt?`, `messageKept: true` | `<turnId>:f` |
| `question` | `requestId`, `prompt`, `options: [{id, label, detail?}]`, `allowFreeform`, `open` | `<turnId>:q` |
| `unsent` | `clientId`, `text`, `reason: "cancelled"|"interrupted"` | `unsent:<clientId>` |
| `image` | `imageId`, `prompt?` | the `ub.row` key |
| `page` | `mediaId`, `title`, `path` | the `ub.row` key |
| `widget` | `widgetId`, `callId`, `connectionId`, `toolName` | `widget:<callId>` |
| `card` | `proposalId` | `card:<proposalId>` |

`turnId` is null for rows written outside a turn (a connect note, a card).

Rows page (`rows-page.json`): `{rows, tailSeq, epoch, running: {turnId, startedAt, rowId?, partialText, activity}|null,
queued: [{clientId, text}], openQuestion: {requestId, prompt, options, allowFreeform}|null,
nextBefore: rowId|null}`. Only the newest page carries `running`, `queued` and `openQuestion`;
older pages (`?before=`) carry `{rows, nextBefore}`. Rows are oldest first within a page.

`activity` is `{kind: "thinking"|"tool"|"compacting"|"retrying", tool?, detail?}`.

## Events (`GET /api/chats/:id/events?after=&epoch=`)

NDJSON, one object per line. Envelope: `{seq, epoch, at, chatId, turnId?, type, ...fields}`.
`seq` counts from 1 per chat per epoch; `stream.ready` and `ping` carry the current `seq` without
advancing it (they are not stored in the ring buffer). Types and fields are SPEC 6.2; the
fixtures pin these details:

- `stream.ready {tailSeq, resync, running: {turnId}|null}` is always the first line.
- `turn.started {origin, clientId?, retry?, resync?}`; `message.user {rowId, clientId?, text, attachments}`
  follows it for owner turns. `resync: true` comes with `retry: true` only: a Retry moves the chat
  back to before the failed attempt, so that attempt's rows (`<failedTurn>:u`, `<failedTurn>:f`) are
  gone from the rows page. The app refetches `GET /rows` (the newest page) when it sees `resync`, and
  its copy of the failed attempt's rows is replaced by the page.
  Routine and system turns have no `message.user`; their prompt is
  hidden context and a `row` note precedes the turn.
- `message.delta {rowId, delta}` and `message.final {rowId, text}` (the final text is
  authoritative and replaces the streamed one).
- `activity {kind, tool?, detail?}`; `tool` is the tool name, `detail` a short label.
- `tool.call {callId, name, widget?: {connectionId, toolName, arguments}}`.
- `tool.result {callId, name, isError, searchResults?}`.
- `row {row}` carries a full row object as above.
- `row.removed {rowId}`: drop that row. It names an assistant row the app already streamed
  (`message.delta`, `message.final`) and that Pi then hid from the model: an attempt Pi retried by
  itself after a cut stream or a length stop. It comes after the retry begins, and the answer that
  follows streams under the next row id (`<turnId>:a<n+1>`), so ids never move. A rebuilt page
  simply lacks the row. Nothing else removes a row.
- `input.requested {requestId, kind: "question", prompt, options, allowFreeform}` and
  `input.resolved {requestId}`.
- `compaction.done {rowId}` follows a `row` event carrying the compaction note.
- `turn.completed {}`, `turn.cancelled {}`,
  `turn.failed {code, detail, retryAfterMs?, resetsAt?, messageKept, rowId}` (a `row` event with
  the failure row comes just before it).
- `message.queued {clientId, text}`, `message.dropped {clientId}` (a `row` event with the unsent
  row comes just before it).

## Files

| File | What it pins |
|---|---|
| `rows-page.json` | a newest page with every row kind, a running turn, a queued message and an open question |
| `rows-page-older.json` | an older page (`before=`) |
| `events-turn.ndjson` | one owner turn: deltas, a `web_search` call with results, a widget call, an image row, a question that ends the turn |
| `events-failure.ndjson` | a failed turn (router `upstream_unavailable` with a retry delay), then the Retry turn |
| `events-queue.ndjson` | three quick sends (two queue), the second runs, cancel drops the third |
| `events-compaction.ndjson` | a turn that compacts in the middle |
| `events-resync.ndjson` | a reconnect with an `after` older than the ring buffer |
| `events-routine.ndjson` | a routine run in its own chat: a note row (carrying the run's turn id), then a turn with no `message.user` |
| `events-auto-retry.ndjson` | Pi retried a cut answer by itself: the streamed partial row is dropped with `row.removed`, the answer streams under the next row id |
| `engine-status.json` | `GET /api/engine/status` |
| `chats-list.json` | `GET /api/chats` |
| `chats-search.json` | `GET /api/chats/search` |
