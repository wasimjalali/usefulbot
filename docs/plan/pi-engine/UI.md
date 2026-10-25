# Pi engine: UI and UX for one bot

> **Owner, 2026-10-25 13:42: the Pi release ships as a brand-new app.** The owner is the only user, so there is
> no migration and no compatibility code for older installs: no `shell.json` v1 migration, no archived or
> earlier bots, no moved routines, no first-launch note, no OpenAPI note, no image-prompt backfill, no eve
> leftovers kept for a release (PR 4 is folded into PR 3). A store whose format changed starts fresh; stores
> whose format didn't (providers, config, Keychain, memory, routines, connections, media) keep working with no
> extra code. Where this file says otherwise, this note wins.

Status: draft 2, 2026-10-25, matches the mockups the owner approved on 2026-10-25. Decision
(owner, 2026-10-25): **one bot only**, no second bot, no bot switcher; the sidebar is built around
chats.

**Approved mockups:** [Chat-first Useful Bot](https://claude.ai/code/artifact/5f4f417b-53ad-4641-81be-1e6f1f52c291)
(private to the owner), source in `docs/plan/pi-engine/mockups/chat-first-useful-bot.html`. Twelve
screens, each a Before (today's app) and After (this spec) artboard; open the file in a browser and
click a board to see it full size. Section 13 lists the pairs. Where this file and the mockups
disagree, this file wins and the mockup is fixed. Companion to `SPEC.md` (engine, protocol) and
`PLAN.md` (who builds what). Visual rules come from the `useful-brand` and `useful-design` skills;
this file fixes structure, states and the contract with the backend.

## 1. Principles

- **One bot, many chats.** The bot is the app's identity, not a list item. Chats are the list.
- **Every visible thing has a backend source, and every backend capability has a place in the UI.**
  Section 9 is the contract; nothing ships that is missing from it.
- **Live state where the work is.** Each chat row shows whether that chat is working, waiting on
  the owner, has an unread reply or failed. No bot-level guessing.
- **Nothing the owner relies on today disappears silently.** Routines, Library, Connectors,
  memory, instructions, approvals, questions and model picking all keep a clear home.
- **The logo is the only bot mark.** The mascot face is not drawn anywhere in the new app: not in
  chat rows, the header, the working row or the empty chat. The Useful Bot logo (black tile, white
  head) sits in the sidebar and at the start of an empty chat. The bot has no editable name, face
  or role label: it is Useful Bot.

## 2. Window

```
+-----------------+----------------------------------------------+
| SIDEBAR 248pt   | STAGE                                        |
|  search  new    |  header band (empty)                         |
|  logo           |                                              |
|  Routines       |  transcript                                  |
|  Library        |                                              |
|  Connectors     |                                              |
|  ------------   |                                              |
|  Today          |  ask column (approvals, question)            |
|   chat rows     |  composer                                    |
|  Yesterday ...  |                                              |
|  ------------   |                                              |
|  account row    |                                              |
+-----------------+----------------------------------------------+
```

The stage shows one of: a chat, the Routines page, the Library page, the Connectors page (owner,
2026-10-25: a page like the others, not a dialog).
There is no right-hand pane: what the Bot pane held moves to Settings (section 6).

## 3. Sidebar

### 3.1 Top band (traffic-light row)

- **Search** (magnifier, ⌘K): opens the search palette (section 7).
- **New chat** (pencil icon, ⌘N; a plus would read as "add"): opens an empty chat on the stage, selected in the list once the first
  message is sent. Replaces today's "New Bot" button. If the open chat is already empty, ⌘N only
  focuses the composer.
- Logo row below, as today.

### 3.2 Fixed entries

Three rows above the chat list, icon plus label, the active one highlighted:

| Row | Opens | Badge |
|---|---|---|
| Routines | Routines page on the stage (section 5) | count of routines whose last run failed, if any |
| Library | Library page on the stage (today's `LibraryView`) | none |
| Connectors | Connectors page on the stage (today's dialog layout, section 8b) | a dot when a connection needs sign-in again |

Library moves out of the account menu. The Connectors footer pill goes (the row replaces it).

### 3.3 Chat list

- Groups by `updatedAt` in the owner's time zone: **Today**, **Yesterday**, **Previous 7 days**,
  **Previous 30 days**, then one group per month ("September", "August 2026" when not this year).
- Row: title on one line (truncated), a trailing state mark or relative time. Height and type
  follow the current compact bot row.
- **State mark per chat** (from `/api/engine/status` chats, polled with approvals every 1.5 s):

| State | Mark | Clears when |
|---|---|---|
| working (a turn is running) | the agent-working dot mark at 0.6 scale (`useful-brand` agent-working motion, #215; it replaced the ring of four dots) | the turn settles |
| waiting on owner (open question or pending approval in that chat) (PR 3) | amber dot | the question is answered, or the approval is decided or expires (5 min) |
| reply ready (a turn settled while the chat was not open) (PR 3) | dark dot (ink; the Useful palette has no blue) | the chat is opened |
| failed (newest turn failed, not retried) (PR 3) | red mark | Retry succeeds or a new turn starts |
| idle | relative time ("2m", "Tue") | |

  Priority when several apply: waiting on owner, working, failed, reply ready.
- Selected chat: the current selection style.
- **Row menu** (hover ··· and right-click): **Rename** (inline edit, Enter saves, Escape cancels,
  60 chars), **Delete** (confirm dialog: "Delete this chat? This can't be undone."). Delete is
  disabled while the chat is working (tooltip "Stop the chat first"). Deleting the open chat opens
  the chat the engine makes current (the newest remaining one), or an empty chat. The engine keeps
  deleted files 30 days as a safety net; there is no restore in the app.
- Order: newest `updatedAt` first. `updatedAt` changes when a turn starts or a row is added, so a
  routine chat moves to the top each time it runs.
- **What PR 2 can show on eve data** (until PR 3 moves the list to the engine): the current chat
  plus up to 40 recents, titles taken from the last message (eve's recents keep no first message),
  no row menu (rename and delete arrive with PR 3), and the working mark only for the open chat.
- Long lists: the first 60 rows render, more load on scroll (`GET /api/chats?before=`).
- Empty list: one quiet line, "No chats yet", under the fixed entries.

### 3.4 Account row (footer)

The owner's avatar and name (operator name from `GET /api/status`) open the account menu as today:
Token usage, Providers, Settings, Appearance, Send feedback, Contact us, version and updates.
Library leaves this menu (3.2); the Connectors pill leaves the footer (3.2).

### 3.5 Background work and notifications

- A routine, connect-card resume or queued turn in a chat that is not open shows only in that
  chat's row (state mark) and, when the turn finishes, as a macOS notification if "Notify when a chat
  finishes" (Settings > General) is on and either the window is not key or the chat is not open.
- Clicking the notification opens that chat.
- The Dock badge shows the number of chats waiting on the owner.

## 4. Stage: chat

### 4.1 Header

- Empty (owner, 2026-10-25): the chat title shows only in the sidebar, so the header band holds
  nothing. It keeps its height for the window's top inset. Rename is in the row menu only.
- No right-side control: the Bot pane toggle goes with the Bot pane.
- The group avatar stack and group header go.

### 4.2 Transcript

Rows come from `GET /api/chats/:id/rows` and live events (SPEC 5.12, 6.2):

- owner bubble, bot bubble (streams), working row (the dots ring, activity label and timer), failure row with
  Retry and cool-down countdown, question card, compaction note, image row, page row, widget row,
  connect card, search chips, note rows (routine ran, connected), unsent row with Send again /
  Edit / Dismiss, queued tag under an owner bubble.
- First launch after the update, in the empty chat: "Chats from the earlier version were not
  carried over. Your bot, notes, routines and connections are all here." Shown once.
- Gone: sub-agent cards and the waiting card, handoff and post strips, "N messages with ..."
  summaries, group attribution, "never got this message" rows, the "Continued from an earlier
  session" divider.

### 4.3 Ask column (above the composer)

- **Approval cards**: as today ("Needs approval", tool, preview, Deny / Approve). A card from
  another chat shows "From another chat: TITLE" and an **Open chat** link; it still docks here so the
  owner never misses one.
- **Question card**: the open question of this chat, as today.

### 4.4 Composer

Unchanged except: no `@name` hint or group placeholder; the model chip, effort, folder and
permission chip, attachments and `+` menu stay. A model change made while a turn runs applies to
the next turn (the chip says so: "Applies to the next message"). Stop (the send button while a
turn runs) cancels the turn. Sending while a turn runs queues the message (queued tag).

### 4.5 Empty chat

The logo (56pt), "What should we do first?", one line ("Useful Bot can research, write, work with
files and run routines for you.") and the three starter prompts as today (`starter-prompt`). No
onboarding "New bot" card.

## 5. Stage: Routines page

Routines move from the 320pt pane to the stage, reusing today's routine list, detail, editor and
history views (`ChatDetailsPaneView.swift` 149-786) at full width:

- Left column: routine list (name, schedule summary, active toggle, last run state). Right:
  the selected routine's detail or the create form.
- **Each routine has its own chat** (SPEC D18), titled with the routine's name and reused for every
  run, so runs never pile into the chat the owner is in. It appears in the sidebar like any chat,
  with a small clock mark before the title. Run history rows link to the chat the run used
  (**Open chat**); a run whose chat was deleted shows "Chat deleted" instead, and a run recorded before PR 3 (no
  `chatId`) shows neither. Deleting a routine
  turns its chat into an ordinary chat (no clock mark). Deleting a routine's chat is allowed; the
  next run starts a new one.
- "Test run" runs it now (as today) in that routine chat.
- A notice while any routine still carries `movedFrom` (set by the archive migration, SPEC D6 and D18):
  "N routines from your earlier bots are paused. Review them and turn on the ones you want."
  Turning a moved routine on or editing it clears its `movedFrom`; Dismiss on the notice clears
  them all (one `PATCH` per moved routine).

## 6. Personalization (instructions and memory) (Settings)

There is no Bot pane. Its contents move to app Settings:

- **Settings > Personalization** (new tab, second in the list):
  - **Instructions**: today's editor with the instruction counter ("1,240 of 8,000",
    `/api/bots/context`) and the hint "Useful Bot reads these at the start of every chat."
  - **Memory**: the notes list (title, who saved it, date, remove), "Show all N notes"; today's
    `MemorySectionView` behaviour.
- **Settings > General**: "Notify when a chat finishes" (with "Only while the window is in the
  background or the chat is closed") and the system-permission note when notifications are off.
- **Profile goes**: no name field, no face color, no role label. The bot is Useful Bot everywhere
  (composer placeholder "Message Useful Bot").
- Routines are their own page (section 5). Group members, delete-bot and "the last bot cannot be
  deleted" go. There is no "create bot" anywhere.

## 7. Search palette (⌘K)

Tabs **All**, **Chats**, **Library**, **Routines**:

- Chats: title and preview match from the chat index, plus message text from
  `GET /api/chats/search?q=` (the engine scans rows; up to 50 hits, each with a snippet and its
  row id). Choosing a hit opens the chat scrolled to that row with a brief highlight.
- Library: generated images, drawings and pages by title.
- Routines: by name; opens the Routines page on it.
- Commands: "New chat", "Open settings", "Connectors", "Token usage".
- The Bots and Groups sections of today's palette go.

## 8. Settings (app)

- Tabs: **General, Personalization** (section 6), **Providers, Computer, Usage, Feedback,
  About**. The nav is 244pt. Providers drops the reviewer role row.
- **Earlier bots** (new, in General, shown only if the migration archived any): one row per earlier
  bot with its name and memory-note count, and three buttons in fixed columns: **Copy instructions**,
  **Move notes** (hidden but holding its place when the bot has no notes) and **Remove** (confirm; deletes that archived bot's record and archives its notes, so they leave memory). This is the
  only place earlier bots appear.

## 8b. Connectors

The Connectors page opens on the stage like Routines and Library, and keeps the dialog's layout and
design (`ConnectorsDialog`, a 760pt column): title and "N added" with
the first logos, "Search 1,500 apps", the **Added** grid, the **All apps** grid with Add, Show more,
the Composio key line. Polish only:

- Added tiles show a state chip instead of "Added": **Connected**, or **Sign in again** (warning) when
  a sign-in expired; the whole tile opens the app's page (chevron on the right, hover tone).
- **App page** (today's `ConnectorDetailPage`, inside the Connectors page): back to Connectors; logo, name and a
  line "App · Composio" (the connectors payload carries only an opaque account id, no account label,
  so "connected as ACCOUNT" waits until one is added); **Reconnect** and **Disconnect** beside the name.
  Below: the state chip, "48 tools · 31 read · 17 write", a segmented **All / Reads / Writes** and
  a **Filter tools** field, then the tools grouped under **Reads** ("Run without asking") and
  **Writes** ("Ask you first in Auto"; destructive tools sit here too), each row the tool slug in mono, a one-line description and
  a Read or Asks first chip. The split follows today's connector risk rules
  (`agent/lib/connector-risk.ts`). A direct MCP server's page has the same shape (Refresh instead
  of Reconnect where today's has it), except the tools: `mcpToolGate` asks for every MCP tool in
  Auto, whatever its name, so the server's page shows one **Writes** group ("Ask you first in Auto"),
  with no All / Reads / Writes segment and no read count (the filter field stays).
- An app whose sign-in lapsed (Composio EXPIRED, FAILED, INACTIVE or REVOKED) stays under **Added** with
  **Sign in again**, and its page puts **Reconnect** first and says "Sign in again to see its tools."
  in place of the tool list (`/api/connectors/tools` answers `needs_sign_in`, not `not_connected`).
  It is not listed again under All apps.

## 9. Contract: UI element to backend

Every row must exist in both columns before PR 3 merges. "PR" says where it is built; the UI of a
"2" row lands in PR 2b where PR 2 held it for the mockups (PLAN "PR 2b").

| UI element | Backend source | PR |
|---|---|---|
| Chat list rows (title, time, order) | `GET /api/chats` (`chats[]`: `chatId`, `title`, `preview`, `updatedAt`) | 2 on shell recents, 3 on the engine |
| Chat state marks | `GET /api/engine/status` `chats[]`: `{chatId, running, waitingOnOwner, replyReadySince, lastTurn}` | 3 (PR 2 shows working only for the open chat) |
| New chat | `POST /api/chats {botId}` | 2 (`newChat` shell action), 3 |
| Rename chat | `PATCH /api/chats/:id {title}` | 3 |
| Delete chat | `DELETE /api/chats/:id` (moves the file to `<stateRoot>/engine/trash/`, purged after 30 days) | 3 |
| Open chat | `POST /api/chats/:id/open` (current chat, clears reply ready) | 2 (`openRecent`), 3 |
| Transcript rows | `GET /api/chats/:id/rows` | 3 |
| Live transcript | `GET /api/chats/:id/events`: `message.user`, `message.delta`, `message.final` (bubbles), `activity` (working row label), `tool.call` / `tool.result` (widgets, search chips), `row` (note, image, page, widget, card, unsent, failure rows), `row.removed` (drops a bubble Pi retried), `compaction.done` (compaction note), `input.requested` / `input.resolved` (question card); `stream.ready` and `ping` are transport | 3 |
| Send, queue, retry | `POST /api/chats/:id/turns`; events `turn.started` (working row on; with `retry` the app re-reads rows), `message.queued` (queued tag), `message.dropped` (unsent bubble with Send again), `turn.completed` / `turn.cancelled` (working row off), `turn.failed` (failure row with Retry) | 3 |
| Stop | `POST /api/chats/:id/cancel` | 3 |
| Approval cards (+ "From another chat") | `GET /api/approvals` (`chatId`, `botId`), `POST /api/approvals/:id` | 3 (`chatId`) |
| Question card | `input.requested` / `input.resolved` events; answer = next turn | 3 |
| Connect cards | `GET /api/proposals`, `PUT /api/shell` confirm and dismiss | 3 |
| Widgets | `tool.call` event, `POST /api/agent/widget {chatId}`, `GET /api/connections/widget/:id` | 3 |
| Images, pages | `row` events; `/api/agent/image/:id`, `/api/agent/media` | 3 |
| Search chips | `tool.result.searchResults` | 3 |
| Routines page | `/api/routines` CRUD, `POST /api/routines/:id/run`, run history with `chatId` | 2 (page move), 3 (`chatId` link) |
| Routine chats in the list (clock mark) | chat index entry `routineId`; `routine.chatId`, `RoutineRun.chatId` | 3 |
| Chat row menu (rename, delete) | `PATCH` / `DELETE /api/chats/:id` | 3 |
| Library page | `/api/agent/media` | 2 |
| Library item actions (open, Show in Finder, Locate, Move to Trash) and chat images | `/api/agent/media/:id`, `/api/agent/image/:id` | 2 |
| Regenerate a lost image | `POST /api/agent/image/:id/regenerate` | 2 |
| A widget's own tool calls (Edit, Open in Excalidraw) | `POST /api/connections/widget/:id/call` | 2 |
| Providers sign-in (ChatGPT, device flows) | `/api/providers/oauth`, `/api/providers/oauth/:pollId` | 2 |
| Token usage | `/api/usage` | 2 |
| Connectors page, its dot and the Connected / Sign in again chips | `/api/connectors`, `/api/connections` (state `needsSignIn`) | 2b: direct MCP servers already carry it (connection state `authFailed` or `expired`); Composio apps gain `needsSignIn` on `/api/connectors` |
| App page Reconnect and Disconnect (Refresh for a direct MCP server) | `/api/connectors` (Composio), `/api/connections` (MCP), the same calls as today | 2 |
| Account row owner name | `GET /api/status` (operator name) | 2 |
| App page tools grouped by reads and writes | `GET /api/connectors/tools?toolkit=` returning each tool's `risk` (`read`, `write` or `destructive`, the last two under Writes) from `connector-risk.ts` | 2b |
| Settings > Personalization: instructions and counter | `PUT /api/shell` `updateBot`, `GET /api/bots/context` | 2, 3 (engine-measured) |
| Settings > Personalization: memory | `/api/memory` | 2 |
| Settings > General: notify when a chat finishes | `PUT /api/shell` `updateBot {notify}` on the one bot; the "only in the background or when closed" rule is today's app-side check, not a setting | 2 |
| Composer model chip | `/api/providers` composer state | 2 |
| Composer folder and permission | `PUT /api/shell` `setWorkspace`, `setPermission`; `/api/workspace` | 2 |
| Attachments | `POST /api/attachments` | 3 (structured parts) |
| Search palette chats | chat index + `GET /api/chats/search?q=` | 2 (titles only), 3 (message text) |
| Notifications, Dock badge | `/api/engine/status` transitions; the badge counts chats waiting on the owner | 3 |
| Token usage, Providers, Settings | as today | unchanged |

Internal (no UI row): `POST /api/agent/tick` (the app's 2.5 s poll that runs the connect pumps and the orphan sweep), `/api/connectors/own-app` (the Needs-your-own-app form's credentials, part of Connectors), `/api/connections/callback`, `/api/connectors/callback` and `/auth/callback` (OAuth returns), `/api/health` and `/api/auth/session`. Removed by the fresh-install note (owner, 2026-10-25): the Earlier bots, moved-routines and first-launch-note rows.

Backend capabilities that have no UI are not allowed. Check at PR 3 review: every route in
`web/app/api/**` and every event type in SPEC 6.2 appears in the table above, or is listed as
internal (SPEC 6.5) or as health and auth.

## 10. Removed UI (complete list)

The Bot pane and its toggle; the Profile section (name, face color, role label); the mascot face
in chat rows, the header pill (the header is now empty), the working row and the empty chat; bot rail rows and pinned bot
cards; sections, Unassigned and Hidden groups; row menu items Pin,
Move, Hide, New section; New Bot button and the create-bot and create-group dialogs; group
settings and members; the new-chat bot picker (`NewChatPickerView`); the onboarding "New bot" card;
sub-agent cards, runs and waiting card; handoff and post strips; fan-out and profile proposal
cards; group avatar stack; reviewer role row; Bots and Groups in search; the rail's
"SUB-AGENTS WORKING" subtitle.

## 11. Keyboard

⌘N new chat, ⌘K search, ⌘R reload chat, ⌘. stop the running turn, ⌘⌫ delete the selected chat
(with the confirm dialog), ⌘↑ / ⌘↓ previous and next chat in the list while the composer is empty
(with text in it they move the caret, as macOS does).

## 12. Verification

Screenshots (light and dark) of: sidebar with all five chat states, row menu, rename, delete
confirm, Routines page, Library page, Settings > Personalization, search palette with a
message hit, an approval from another chat, Earlier bots, Connectors with a Sign in again chip, an
app's tools page. Compare each against its After artboard. A 30 fps recording of: sending a message while another chat's routine
runs (its row turns to working, then reply ready, then the notification), and of deleting the open
chat. All in Useful Bot Dev with its one bot.

## 13. Approved artboards

| Screen | Before (today) | After (this spec) |
|---|---|---|
| Main window | bots in sections, bot in the header | chats by day with states, empty header (the artboard's title pill is superseded by 4.1) |
| Row menu | Pin, Move, Settings, Rename, Hide, Delete | Rename, Delete |
| Delete confirm | "Delete bot" | "Delete this chat? This can't be undone." |
| Rename | dialog | inline in the sidebar row (the artboard's header rename is superseded by 4.1) |
| Approval card | the other bot's name | "From another chat: TITLE", Open chat |
| Routines | in each bot's pane | own page, one chat per routine, moved-routines notice |
| Personalization | the bot's Settings pane | Settings tab, no Profile |
| Search | Bots, Groups, New Bot | Chats, Library, Routines, message hits |
| New chat | "To: Search or create bots" picker | empty chat with the logo and the first-launch note |
| Your other bots | sidebar rows | Settings > General > Earlier bots |
| Connectors | dialog with "Added" | the same layout as a stage page, Connected / Sign in again |
| An app's tools | plain list | Reconnect, Disconnect, reads and writes, filter |
