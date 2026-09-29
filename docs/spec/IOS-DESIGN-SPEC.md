# Useful Bot for iOS: design specification

Status: final draft for the build, 2026-09-19. Consumed alongside the frozen
`docs/spec/IOS-APP-SPEC.md` ("the spec") and the iOS mockups.

- **Mockups:** the Claude Design canvas "Useful Bot iOS"
  (https://claude.ai/artifact/TJkoZqMsC53FE18sFiojAK): 50 iPhone boards, a dark twin of each
  ("Dark: Bots"), one dark board recording the rejected token scrim, and a handoff board. Mockups are cited by their board title, for example
  "Bots" or "Approval docked". The boards were redrawn on 2026-09-19 to match this document;
  where they differ, this document wins.
- **Authority order:** the macOS app is the source of truth for look and behavior. The spec is
  law for tokens, states and the blacklist. Mockups carry layout intent. Where a mockup and the
  spec disagree, section 2 records which wins. This document never overrides the spec; anything
  it could not settle is in section 6.
- **Token names** are the ones in `macos/Sources/UsefulBotCore/DesignTokens.swift` and the
  macOS `NativeTheme` (`edge`, `shadow`, `overlay`). Values not in those files are marked
  **new**; the iPhone additions in section 4.3 were approved by the owner on 2026-09-19.

Contents:

1. Per screen: anatomy, sizing, components, states, appearances, Dynamic Type
2. Reconciliation: mockups against the spec
3. Blacklist violations inside the mockups
4. Token mapping and contrast
5. Components and reuse boundaries
6. Owner decisions and closed items

---

## 1. Per screen

### 1.0 Rules every screen inherits

These apply to all eighteen screens and are not repeated below unless a screen differs.

**Layout frame**

- Screen side gutter: 16 pt (**new** `Space.phoneGutter`). Grouped content sits inside it.
- Safe areas are respected. No content draws under the status bar or home indicator. The
  composer docks with `safeAreaInset(edge: .bottom)`, never with keyboard padding math.
- Navigation bar: system inline style, background `surface` on chat screens and `canvas` on
  list screens, a 1 pt `border` hairline under the chat header only.
- Every tappable element has a hit area of at least 44 by 44 pt, even where the glyph is
  smaller (A.7).
- Canvas sits one tone step under surfaces: `canvas` behind lists and grouped settings,
  `surface` for the chat stage, groups, sheets and cards.

**Shared states (the baseline)**

Every screen implements all eight states from spec section 11. The baseline behavior is below;
each screen's table lists only what is specific to it.

| State | Baseline |
|-------|----------|
| Empty | Calm text, left-aligned except where noted, never an illustration. Title `ink`, body `inkMuted`. |
| Loading | Skeleton blocks in `border` at the loaded geometry, `Radius.xs` for text bars and circles for avatars, 1.6 s opacity pulse. Header renders first. No spinners in content areas. Reduce Motion: static skeleton. |
| Error | Inline and muted: `danger` glyph plus one sentence in `inkMuted`, and a secondary "Retry" button where a retry makes sense. Copy from the shared error taxonomy and spec section 8.4. |
| Pressed | Rows: background steps to `sunken` (dark: `sunken`) for the press, 150 ms ease-out back. Buttons: scale 0.98 plus one tone step. No hover. |
| Focus-visible | External keyboard or Full Keyboard Access: 2 pt `accent` ring, 2 pt offset, `Radius.xs` corners outside the element's own radius. VoiceOver order equals visual order. |
| Active | Selected or on items use the monochrome accent: selected segment is a `surface` pill on a `border` track; toggles on are `brand` track with `brandInk` knob; selected list option shows a `sunken` row card plus a checkmark. |
| Disabled | Quieter fill (`sunken`, glyph `inkFaint`) plus a reason line in `inkMuted` directly under or beside the control. The reason is one of: "You're offline", "Your Mac is unreachable", "Agent runtime is down on your Mac", "Session expired. Sign in again", "Locked. Unlock to send". Never grey alone. |
| Offline | Readiness banner at the top of list screens and under the chat header (section 1.2 and 1.3). Cached content stays visible with its age. Mutations disabled with reasons. Composers stay editable with Send disabled; drafts persist. |

**Appearances.** Both light and dark are designed and screenshotted for every screen. Dark uses
the `DarkHex` set: `canvas #0F0F0F` under `surface #171717`, bot bubbles `bubbleBot #202020`,
lift carried by `edge` (white 7%) and the tone step because shadows stay dark. Status colors
lighten and their soft fills darken per the token table.

**Dynamic Type baseline.** All sizes are token sizes wrapped with `relativeTo:` (body for text,
footnote for meta, caption for labels). At accessibility sizes: rows grow in height, never
truncate names to one letter; trailing pills and buttons drop under the text; chip rows wrap
to two lines; segmented controls with more than three options become a vertical option list.

**Class A and B gates** (spec section 4.4) look the same everywhere: the action's button
shows its label, tapping it runs Face ID or passcode, the button shows a pressed state while
evaluating, and cancel returns to the exact pre-tap state. Failure with `passcodeNotSet`
shows "Set a passcode on this iPhone to approve actions" inline under the button.

---

### 1.1 Pairing (states `unpaired`, `credentialInvalid`)

Mockups: "Pair with Mac", "Pair, camera denied", "Pair again".

**Anatomy, top to bottom**

1. Top padding 32 pt.
2. Brand logo, 56 pt circle (`brand/svg/useful-bot-logo.svg`, copied into the `useful-bot-badge` image set by `npm run brand:build`, never redrawn).
3. 20 pt gap, title "Connect to your Mac", `FontSize.emptyTitle` 28, semibold, tracking
   `Tracking.tight`.
4. 8 pt gap, one line in `inkMuted`, `FontSize.emptyBody` 15: "Your bots run on your Mac. This
   iPhone connects to it over Tailscale."
5. 28 pt gap, scanner area: full gutter width, square up to 300 pt, `Radius.xl` 22, camera
   preview fills it, four corner guides in white at 80% opacity, 1.5 pt stroke.
6. 16 pt gap, status line (`inkMuted`, 15), for example "Point the camera at the code on your
   Mac".
7. Steps list, numbered because genuinely sequential: "On your Mac, open Settings, then
   Devices.", "Choose Show pairing QR.", "Scan the code."
8. Flexible space, then a full-width secondary button "Enter manually", 50 pt tall,
   `Radius.md`.

**Manual entry** (pushed inside the same screen): two fields, "Mac address" (host, URL
keyboard) and "Pairing token" (secure field, masked), `Radius.md`, `Control.fieldMinHeight`
40 raised to 48 for touch, 16 pt between. Primary button "Connect", disabled until both are
non-empty.

**States**

| State | Treatment |
|-------|-----------|
| Empty | The default screen above. |
| Loading | After a scan or Connect: scanner freezes on the last frame, status line reads "Connecting to your Mac", button disabled with that reason. |
| Success | Status line "Connected to Mac Studio" (the payload `name`) in `success`, then dismiss into Bots list after 600 ms. |
| Error | Status line in `danger` with the exact spec copy: "Can't reach your Mac. Is it awake and on Tailscale?", "This pairing was revoked. Re-pair from the Mac", the TLS failure stated plainly, "This code is from a newer version of Useful Bot", or the endpoint rule that failed. Scanner resumes. |
| Camera denied | Scanner area becomes a `sunken` block with "Camera access is off" and a secondary "Open Settings" button; the manual entry fields show inline below it, no extra tap. |
| Credential invalid | Same screen, title "Pair again", status line "This pairing was revoked or expired. Scan a new code from your Mac." A tertiary text button "Unpair" at the bottom (class A). |
| Pressed, focus, disabled | Baseline. |
| Offline | Status line "You're offline" and scanning paused; manual Connect disabled with that reason. |

**Dark.** Scanner corners stay white; screen background `surface #171717`.
**Dynamic Type.** Title wraps to two lines; scanner shrinks to keep the button on screen, never
below 200 pt; steps reflow.

---

### 1.2 Bots list

Mockups: "Bots", "+ menu", "Bots, empty", "Connecting", "Mac unreachable".

**Anatomy**

1. Navigation bar, 48 pt: leading badge 32 pt plus "Useful Bot" (22 pt semibold, **new**
   `FontSize.phoneLargeTitle`), trailing "+" icon button (opens the + menu) and the profile
   avatar 32 pt (`Control.operatorAvatar`), which opens App settings. The avatar is the
   spec's "profile row" (section 2, item R7).
2. Readiness banner, only when not `ready` (see below).
3. Search field, 40 pt tall, `Radius.md`, `surface` fill with `edge`, placeholder "Search" in
   **new** `inkFaintText`. Tapping opens Global search as a sheet.
4. Pending approvals entry, only when any approval is pending (see below).
5. Pinned: each pinned bot is a lifted card (`surface`, `edge`, lift shadow, `Radius.lg`),
   12 by 14 pt padding, avatar 44 pt, name 15 pt semibold. No label line when the label
   equals the name.
6. Sections in order: named sections, then "Unassigned", then "Hidden" (collapsed by
   default). Header: chevron 12 pt plus title, sentence case, 13 pt medium, `inkMuted` (not
   `inkFaint`, A.7), 44 pt tall hit area.
7. Bot rows, min height 60 pt, 20 pt leading: avatar 40 pt, 12 pt gap, name
   `FontSize.chatName` 15 semibold, label under it (see R2). Group rows show a two-face
   avatar stack in the same 40 pt box.

**Pending approvals entry.** A lifted row card at the top of the list, above pinned:
warning-soft pill "3 waiting" on the right, leading `checkmark.shield` glyph, title "Approvals".
Tapping pushes Pending approvals (1.10). It is the only place warning color appears on this
screen (see R1).

**Readiness banner** (spec 7.2). A lifted card, `Radius.md`, 12 by 14 pt, glyph plus title plus
one line, trailing secondary "Retry" where useful.

| Level | Glyph | Title | Line |
|-------|-------|-------|------|
| `noNetwork` | `wifi.slash` | You're offline | Showing what was cached 4 min ago. |
| `macUnreachable` | `desktopcomputer` | Your Mac is unreachable | Last seen 12 min ago. Bots pick up when it's back. |
| `runtimeDown` | `exclamationmark.triangle` | Agent runtime is down on your Mac | Settings still work. Chats are paused. |
| Credential expiring (one time, 7 days) | `key` | Pairing expires in 7 days | Re-pair from your Mac before then. |

**+ menu.** A system menu anchored to "+": New bot, New group, New section. (Not a sheet.)

**Row actions.** Swipe leading: Pin or Unpin. Swipe trailing: Hide. Long press: context menu
with Pin, Rename, Move to section, Settings, Hide, New chat, Delete (destructive, confirms).

**States**

| State | Treatment |
|-------|-----------|
| Empty | No bots: "Create your first bot" (macOS copy) as the only content, with a primary "New bot" button under it. |
| Loading | Mockup "Connecting": header and badge render, a status line "Connecting to Mac Studio" with a `inkFaint` dot, pinned card skeleton, section title bar, five row skeletons. |
| Error | `GET /api/shell` fails while reachable: cached list stays, inline error line under the search field with Retry. |
| Working | A bot with a running turn shows the breathing avatar (brand motion, 1.6 s) with its label unchanged. VoiceOver: "Test Bot, working, double-tap to open". Reduce Motion: static frame plus the word "Working" appended to the label line. |
| Pressed, focus | Baseline. Selection never changes weight. |
| Active | iPad split view only: the open bot's row lifts as a small `surface` card with `0 1 2` shadow at 6%. |
| Disabled | New bot, New group and New section are disabled when not `ready`, with the reason in the menu item's subtitle. |
| Offline | Banner per level; rows stay tappable (cached chats open read-only). |
| Forbidden | A row action rejected by 403 shows a toast "Your Mac refused this change" with the code in `inkMuted`. |

**Dark.** Canvas `#0F0F0F`, pinned card and banner `surface #171717` with `edge`.
**Dynamic Type.** Rows grow; the approvals pill drops below its title; the avatar stays 40 pt;
section chevrons stay beside titles; the search field grows in height.

---

### 1.3 Chat

Mockups: "Chat, bot working", "Composer locked", "Approval docked", "Approval states", "New
chat", "Failed turn", "Runtime down", "Model and effort", "Permission", "Add to message", "Add to
message, no key", "Connectors", "Mention list", "Mention list, filtered", "Mention list, no
match", "Mention list, largest text", "Folder sheet", "Folder sheet, no folder".

**Anatomy**

1. Header, 48 pt, `surface`, bottom hairline: back chevron (44 pt target), avatar 28 pt, name
   17 pt semibold (**new** `phoneNavTitle`), trailing gear "Bot settings" (opens Bot
   settings sheet). The whole name area also opens Bot settings.
2. Readiness strip under the header when not `ready`: the banner from 1.2 at full width,
   flat (no lift), `sunken` fill.
3. Transcript, `surface` stage, 16 pt side padding, 12 pt top. Scroll law is A.4 and A.7,
   verbatim.
   - User bubble: right, max 82% width, `sunken` fill, `Radius.md`, 10 by 14 pt padding,
     `chatBody` 15 / `chatLineHeight` 24.
   - Bot bubble: left, max 90%, `bubbleBot`, `edge` plus lift shadow, same radius and padding.
     Consecutive bubbles from one bot stack at `Space.bubbleStackGap` 6; a new speaker starts
     after 16 pt (phone value of `transcriptGap`, **new** `phoneTranscriptGap`).
   - Day divider: centered label "Today", "Yesterday" or the date, 12 pt, `inkMuted`, hairlines
     either side. No clocks on rows.
   - Bot-meta rows ("Message from Growth Tracker"), 12 pt `inkMuted`, centered.
   - Working row: avatar 28 pt breathing, activity label in `inkMuted` and elapsed time. It is
     replaced by the first token, never removed.
   - Search chips under a turn, connected-app cards, widgets (1.17), proposal and owner-question
     cards use the status card recipe: lifted, 8 by 12 pt, status pill right.
4. Docked asks, above the composer: approval cards, owner questions, proposals needing an
   answer. At most one expanded; more than one shows "2 more waiting" as a row that expands
   the stack.
5. Composer (the mockup layout, owner-approved):
   - Raised field, `Radius.xl` 22, `bubbleBot` with a 2% top-down fall, `edge` at rest and
     `borderStrong` on focus, raise shadow. Padding 12 pt top, 8 pt sides and bottom.
   - Row 1: multiline text, grows to `Control.composerExpandedMax` 160 pt then scrolls.
     Placeholder "Message Drive Admin" in `inkFaintText`.
   - Row 2: "+" (36 pt `sunken` circle in a 44 pt target), then the model chip right-aligned
     ("GPT-5.6-Luna Medium", model semibold `ink`, effort `inkMuted`, 13 pt), then Send.
   - Send: 36 pt circle in a 44 pt target. Sendable: `brand` fill, 14% top sheen, `brandInk`
     arrow. Not sendable: `sunken` fill, `inkFaint` arrow. Streaming: same fill with a stop
     square.
   - Lock glyph: when the bot is `full_access` and not unlocked this activation, a 14 pt
     `lock.fill` sits inside the Send circle's top-right as a badge, and Send's accessibility
     label becomes "Send, locked. Face ID required". First send runs the class B check.
6. Session chips under the composer, 6 pt below it: folder chip and permission chip only.
   - Folder chip is **read-only on the phone** (R9): folder glyph plus the folder name, no
     chevron. With no folder attached it reads "No folder" in `inkMuted`. Tapping opens the
     Working folder sheet (below).
   - Permission chip: shield glyph plus the level in semibold, chevron, opens the Permission
     sheet.

**Sheets opened from chat** all use the floating sheet (section 5, `FloatingSheet`): 8 pt from
the screen sides and bottom, `Radius.xl` on all four corners, grabber, title row with close.

- **Model and effort.** Search field, models grouped by provider (provider mark 18 pt, name
  15 pt), picked row as a `sunken` card with a checkmark, then Effort as a token segmented
  control (Low, Medium, High, XHigh) and Speed ("Fast" toggle). Detents: medium, large.
- **Permission.** Three option rows (Read only, Auto, Full access), each a 40 pt icon tile, name
  semibold and one line of consequence copy, picked row as a `sunken` card plus checkmark.
  Footer line "Applies to Drive Admin on your Mac." Moving toward Auto or Full access is
  class A.
- **Add to message.** Recent photos strip (84 pt tiles, `Radius.md`), then rows Photos,
  Camera, Files, a hairline, and Connectors with a trailing chevron. With no Composio key saved,
  the last row reads "Set up connectors in Settings" (same grid glyph and chevron); tapping it
  dismisses the sheet and pushes Settings, Connectors on the key form (1.13).
- **Working folder.** Smallest-fit detent. A `sunken` row card with the folder glyph and the
  folder name in `ink` semibold, or "No folder attached" in `inkMuted`; then "Attach a folder
  from your Mac. This iPhone can't change it." in `inkMuted` 15; then a full-width secondary
  "Done". No other actions: attaching is blocked on the phone (F2).
- **Connectors (from chat).** Pushes inside the same sheet, which grows to the large detent:
  back chevron, title, close. Content is the Connectors list component (1.13).

**Group chat @mentions** (boards "Mention list" and its variants)

- **Trigger.** Typing "@" at the start of the field or after a space opens the list. The text
  after "@" up to the caret is the query. It closes on a space when nothing matches, on
  selection, on deleting the "@", or when the field loses focus.
- **Candidates.** The group's members only, in roster order (the orchestrator is reached by an
  untargeted message, so it is not listed). Matching is case-insensitive on the start of any
  word in the name or label: "st" finds Storyboard Artist, "pro" finds YT Producer.
- **Anchor.** Docked directly above the composer inside the dock, full composer width, 8 pt
  gap. It sits above any docked ask. A lifted card (`surface`, `edge`, lift shadow,
  `Radius.lg`), 6 pt vertical padding.
- **Height cap.** Four rows (52 pt each), then the list scrolls inside the card. At
  accessibility sizes the cap is three rows.
- **Row.** `BotRowView` at 32 pt avatars: avatar, 12 pt gap, name 15 semibold, label under it
  when it differs from the name. Row 52 pt, `Radius.sm` highlight inset 6 pt. The first row is
  highlighted (`sunken`) as the default target.
- **Insert.** Tapping a row (or Return with a hardware keyboard) replaces the query with
  "@" plus the full name and a trailing space, which is the form the shared mention parser
  matches (`Threads.parseMentions`, full names, case-insensitive).
- **Keyboard.** Up and Down move the highlight, Return inserts, Escape closes. Tab is not
  captured.
- **VoiceOver.** Focus stays in the text field. When the list appears it announces "3
  suggestions"; each row reads "YT Producer, group member, double-tap to mention"; swiping
  right from the field reaches the list.
- **Empty result.** One non-interactive row, "No member named "zz"", in `inkMuted`. The list
  closes on the next space.
- **Largest text.** Rows grow to 64 pt, names wrap to two lines instead of truncating, labels
  drop, cap three rows.
- **Dark.** The card is `surface #171717` on the `#171717` stage, so it relies on `edge` and the
  row highlight `sunken #2C2C2C`; both are drawn on the dark boards.

**States**

| State | Treatment |
|-------|-----------|
| Empty | Mockup "New chat": avatar 64 pt and "What can I do for you?" centered, then four everyday prompt tiles (`StarterPrompt.everyday`, 2 by 2, a tap fills the composer and sends nothing; macOS replaced the permission-aware copy with them on 2026-09-29). Group chats use the group copy. The onboarding card on a fresh bot sits under it. |
| Loading | Header first, then bubble-shaped skeletons (two left, one right) at real bubble sizes, transcript streams in as it arrives. Never hide the transcript while loading. |
| Error (turn) | Mockup "Failed turn": a status card in `dangerSoft` with a 40% `danger` edge, title "The model didn't answer", the provider's reason in `inkMuted`, secondary "Retry" (posts a fresh session, as the Mac). |
| Error (stream) | "Session ended" or "Interrupted" line in `inkMuted` under the last turn, with "Resume". |
| Confirming | The sent bubble shows at 60% opacity with "Sending, confirming" under it in `inkMuted`; resolves to sent or to "Not sent" with Retry. Never auto-resends. |
| Conflict (409) | Toast at the top of the transcript: "Your Mac moved this conversation", then the transcript adopts the new session with the two-beat swap. |
| Pressed, focus | Baseline. Bubbles have a long-press menu (Copy, Share) with the system highlight. |
| Active | Composer focused: edge to `borderStrong`. |
| Disabled | Send disabled with the reason as a line under the chips, for example "Agent runtime is down on your Mac". Locked is not disabled: it prompts. |
| Offline | Readiness strip; composer editable, Send disabled with reason; the draft persists; transcript shows "Cached 4 min ago" in the strip. |
| Runtime down | Strip "Agent runtime is down on your Mac"; Send disabled; Bot settings gear stays live. |
| Passcode unavailable | Class A or B attempt shows "Set a passcode on this iPhone to approve actions" under the button or composer. |
| Forbidden | Inline on the action, for example under an approval card: "Your Mac refused this: phone_forbidden_action". |

**Approval card** (docked; one component, many states)

Anatomy, top to bottom, inside one lifted card, `Radius.lg`, 12 by 14 pt:

1. Provenance row: bot avatar 20 pt, "Drive Admin asks" 13 pt semibold, expiry countdown on
   the right ("4:32", `inkMuted`, tabular figures).
2. Working directory: folder glyph plus the path in SF Mono 13, `inkMuted`, middle-truncated to
   one line, full path on long press.
3. Preview: the full command or change in a `sunken` block, SF Mono 13, `Radius.md`, scrolls
   inside the card when taller than 160 pt. No six-line cap (A.7).
4. Actions: "Deny" secondary and "Approve" primary, equal widths, 44 pt tall. The label stays
   "Approve" (owner decision, section 6): two buttons share one phone row.
   Approve is class A and bound to the rendered `{id, actionSha256}`.

| State | Treatment |
|-------|-----------|
| Pending | As above. |
| Approving | Approve button shows a pressed state and "Approving"; Deny disabled. |
| Approved | Card collapses to a one-line status card: "Approved" `success` pill. |
| Denied | One line, "Denied" `quiet` pill. |
| Expired | One line, "Expired" `quiet` pill, "Ask again" text button. |
| Resolved on your Mac | One line: "Resolved on your Mac" `quiet` pill. |
| Changed | The card re-renders with the new preview and a `warningSoft` line "This request changed. Check it again."; Approve is not sent. |

**Dark.** Stage `#171717`, bot bubbles `#202020`, user bubbles `sunken #2C2C2C`, composer
`bubbleBot` with `edge`; send fill `brand #EDEDED` with a `#141414` glyph.
**Dynamic Type.** Bubbles reflow and stay within their max widths; the composer's second row
wraps the model chip onto its own line above "+" and Send at accessibility sizes; the two
session chips stack; approval buttons stack vertically with Approve on top.

---

### 1.4 Past conversation

Mockup: "Past conversation". Pushed from Bot settings or Global search.

**Anatomy.** Header like Chat but with the conversation title (17 pt semibold) and date under it
(12 pt `inkMuted`). Read-only transcript with the Chat bubble rules. No composer: a bottom bar
on `surface` with a primary full-width "Continue this conversation" (class A), 50 pt,
`Radius.md`, 16 pt gutter.

| State | Treatment |
|-------|-----------|
| Empty | "This conversation has no messages." |
| Loading, error, pressed, focus | Baseline and Chat. |
| Active | None. |
| Disabled | "Continue" disabled with the readiness reason. |
| Offline | Cached transcript with its age in the header subtitle. |

**Dynamic Type.** Title wraps to two lines in the header.

---

### 1.5 Bot settings (sheet)

Mockup: "Bot settings" (a sheet, per R11).

**Anatomy.** Large-detent floating sheet on `canvas`, grabber, title "Bot settings", Done.

1. Identity block, centered: avatar 72 pt (tap to edit shape and color), name 22 pt semibold,
   label under it only when it differs from the name.
2. Group "Profile": Name, Label, Description (multiline), each a field row.
3. Group "Avatar": shape and color picker (the Mac's face picker), swatches 44 pt targets.
4. Group "Defaults": Model (value "GPT-5.6-Luna · Medium", chevron), Permission (value, chevron,
   class A on escalation), Working folder (read-only value, no chevron, footer "Attach a folder
   from your Mac").
5. Group "Routines": rows with name, schedule line ("Mondays at 09:00, Europe/Berlin"), state
   pill, chevron; a "New routine" row with a plus glyph. Footer: "Runs while Useful Bot is open
   on your Mac or this phone."
6. Group "Memory": the notes list (mirrors the Mac pane).
7. Group "Past conversations": latest five, "Show all".
8. Destructive group: "Clear conversation" and "Delete bot", `danger` text, each confirms, both
   class A.

Groups: `surface` on `canvas`, `Radius.md`, rows 52 pt min, inset hairlines, group titles 13 pt
medium `inkMuted`.

| State | Treatment |
|-------|-----------|
| Empty | Routines: "No routines yet." Memory: "Nothing remembered for Drive Admin yet." (macOS copy). |
| Loading | Group skeletons. |
| Error | Per group, inline with Retry. |
| Pressed, focus, active | Baseline. |
| Disabled | Writes disabled with reason when not `ready`. "Delete bot" disabled for the last bot with "The last bot cannot be deleted." |
| Offline | Values shown from cache; every write disabled with reason. |
| Confirming | Destructive confirms use the smallest detent that fits (A.5). |

**Dark.** Sheet `canvas #0F0F0F`, groups `surface #171717`. (Not the mockup's `#1B1B1B`, see
V8.)
**Dynamic Type.** Value text moves under its label; the identity block stays centered.

---

### 1.6 Group settings (sheet)

Mockup: "Group settings". Same frame as Bot settings.

**Anatomy.** Identity block with the avatar stack; groups "Profile" (Name), "Members" (member
rows with avatar 32 pt, name, a remove control; "Add members" row opens a multi-select list),
destructive "Delete group".

| State | Treatment |
|-------|-----------|
| Empty | Members: "No members yet." |
| Other states | As Bot settings. |

**Dynamic Type.** Member rows grow; remove control stays trailing.

---

### 1.7 Create flows (sheets)

Mockups: "New bot", "New group", "New section", "Rename", "Move to section", "Delete confirm".

- **New bot:** floating sheet, Cancel and title, avatar preview 84 pt centered, "Avatar color"
  swatches (the approved palette only, 44 pt targets, picked one ringed with a 2 pt `ink`
  ring), fields Name, Label, First brief (multiline). Primary full-width "Create bot", disabled
  until Name is non-empty. Class C.
- **New group:** Name field, then member multi-select (rows with avatar and a trailing
  checkmark circle). Primary "Create group".
- **New section:** one field and "Create section". Smallest detent.
- **Rename:** one field prefilled, "Save". Smallest detent.
- **Move to section:** a list of sections plus "Unassigned", checkmark on the current one.
- **Delete confirm:** title "Delete Drive Admin?", one line of consequence ("Its conversation
  and routines are removed from your Mac."), destructive "Delete bot" (class A for bots) and
  "Cancel". Smallest detent.

| State | Treatment |
|-------|-----------|
| Empty | Fields empty, primary disabled with "Add a name" as its reason. |
| Loading | Primary shows "Creating" pressed state. |
| Error | Field-level error under the field in `danger` 13 pt, or a sheet-level line for server errors. |
| Pressed, focus, active, disabled | Baseline; focused field edge `ink` plus 3 pt ring at 8%. |
| Offline | Primary disabled with reason. |

**Dynamic Type.** Swatches wrap to two rows; fields grow.

---

### 1.8 Routine editor (sheet)

Mockup: "Routine".

**Anatomy.** Large-detent floating sheet. Title is the routine name.

1. "Active" toggle group (enabled or paused).
2. "What Drive Admin should do each time": multiline field, min 96 pt.
3. "When to run": token segmented control "Every week", "Every day", "Once".
4. Weekly: seven day circles, 40 pt visible in 44 pt targets, picked is `brand` fill.
   Once: a date row.
5. Group: Time (value in `ink` semibold), Time zone (the phone's current zone, shown and sent).
6. "Next run: Monday 09:00, Europe/Berlin" in `inkMuted`.
7. Secondary full-width "Test run" (class A).
8. "Run history": rows with date and time, state pill, chevron to the run's session.
9. Footer: "Runs while Useful Bot is open on your Mac or this phone."
10. Save in the title bar (class A); "Delete routine" at the bottom in `danger` (class A).

| State | Treatment |
|-------|-----------|
| Empty | Run history: "No runs yet." No schedule: "No schedule yet. This routine only runs when you test it." (macOS copy). |
| Running | Header pill "Running" (`quiet`), Test run disabled with "Already running". |
| Last run failed | History row pill "Failed" (`bad`), tap opens the session. |
| Loading, error, pressed, focus, active | Baseline. |
| Disabled | Save disabled until the schedule is valid, with the reason ("Pick at least one day"). |
| Offline | All writes disabled with reason; history from cache. |

**Dynamic Type.** Day circles become a two-row grid; the segmented control becomes a vertical
option list.

---

### 1.9 Global search (sheet)

Mockups: "Search", "Search, no match".

**Anatomy.** Full-height sheet: search field focused on open (40 pt, `Radius.md`, focus edge
`ink`), Cancel. Results grouped by bot: each group is the bot row, then its matching items
(label, description, section, recent conversation titles) as indented 15 pt rows. Match
highlight: the matched characters in semibold `ink` (not a background block; see V7).

| State | Treatment |
|-------|-----------|
| Empty (no query) | Recent bots, up to five. |
| No match | "No matching chats or bots." (macOS copy), then a secondary "New bot" button. |
| Loading | Row skeletons under the field. |
| Error, pressed, focus, active, disabled | Baseline. |
| Offline | Searches the cached shell only, with a line "Searching what's on this phone". |

**Dynamic Type.** Group items reflow; the field grows.

---

### 1.10 Pending approvals (push)

Mockup: "Pending approvals".

**Anatomy.** Title "Approvals". Grouped by bot: section header is the bot avatar 20 pt plus
name. Each item is a lifted row card: first line of the preview in SF Mono 13 (one line), the
directory in `inkMuted` 13, the countdown on the right. Tap opens the chat with that card
focused and expanded.

| State | Treatment |
|-------|-----------|
| Empty | "Nothing is waiting for you." |
| Loading, error, pressed, focus | Baseline. |
| Offline | List marked "Cached 2 min ago" in the header; items open read-only. |
| Resolved elsewhere | The item leaves the list with a 120 ms fade. |

**Dynamic Type.** Countdown moves under the preview.

---

### 1.11 App settings

Mockup: "Settings".

**Anatomy.** Title "Settings" with Done. Groups on `canvas`:

1. Account row (flat group, not lifted): avatar 48 pt, operator name 15 semibold, "Change photo"
   secondary small button. Photo is device-local.
2. "General": Operator name, Language, Time zone.
3. "Appearance": Theme, token segmented System / Light / Dark.
4. "Bots": Providers, Connectors, Usage (chevrons).
5. "Devices": Mac name with its status pill ("Connected" `ok`, "Unreachable" `warn`),
   chevron to Devices.
6. "About": Version, value only.

| State | Treatment |
|-------|-----------|
| Loading, error, pressed, focus, active | Baseline. |
| Offline | Appearance still works (device-local). Other rows open cached views. |
| Credential expiring | Devices row shows "Expires in 7 days" `warn` pill. |

**Dynamic Type.** The theme control becomes a vertical option list; values move under labels.

---

### 1.12 Provider detail (push)

Mockups: "Providers", "Provider detail".

**Providers list anatomy.** Group "Connected": rows with the provider mark in a 36 pt `sunken`
tile, name 15 semibold, mode line 13 `inkMuted`, status pill. Group "Task models": Chat model
row. Secondary "Add provider". Footer: "Keys stay in your Mac's Keychain. This iPhone never
holds them."

**Detail anatomy.** Provider mark and name header; mode-specific form per
`shared/provider-catalog.ts`:

- Device flow: "Sign in" primary; then a code card (code in SF Mono 20, "Copy code") and a
  Safari sheet; polling status line "Waiting for you to finish in Safari".
- API key: secure field plus "Save key" (class A).
- Local: server URL field plus "Connect".

Then Model, Effort and Speed pickers (same components as the Model sheet), and "Disconnect"
in `danger` (class A).

| State | Treatment |
|-------|-----------|
| Empty | Not connected: the form alone. |
| Loading | "Connecting" on the primary; poll line. |
| Error | Rejected key: field error "Key rejected" plus the provider's reason. Poll `expired` or `failed`: reason plus "Try again". |
| Pressed, focus, active, disabled | Baseline. |
| Offline | Form disabled with reason. |

**Dynamic Type.** The code card wraps the code to two lines at the largest sizes.

---

### 1.13 Connectors (push from Settings; also inside the Add to message sheet)

Mockups: "Connectors" (inside the Add to message sheet), "Connectors, key set", "Connectors, no
key", "Connectors, key rejected", "Add to message, no key".

**Anatomy.** Search pill (40 pt, `Radius.pill`, `borderStrong` edge, `ink` on focus), then a
flat list (no container card, see V6): each row 64 pt min, app logo 36 pt in a `Radius.sm`
tile, name 15, status line 13 (`success` "Connected", `inkMuted` "Not connected", "No sign-in
needed", "Waiting for approval in the browser", "Still not connected. Try again."), trailing
button: "Connect" primary small or "Disconnect" secondary small, 36 pt visible in a 44 pt
target. Inset hairlines. "Show more" secondary at the end.

**Key configuration** (Settings entry only; closed item 3). A "Composio API key" section at
the top of Settings, Connectors, matching the Mac's `keyForm`:

- **No key:** secure field, placeholder "Paste key", then a full-width primary "Save key",
  disabled (quiet `sunken` fill) until the field has text, with the reason "Paste a key to save
  it" under it. Then a link row "Get a key at composio.dev", underlined, trailing share glyph,
  opening Safari. Then the line "Apps show here once a key is saved. Saving or removing a key
  needs Face ID." The app list is hidden.
- **Key rejected:** the same form, field edge in `danger`, "Key rejected" in `danger` 13
  semibold and the server's reason in `inkMuted` under it ("Composio returned 401: invalid API
  key."). "Save key" enabled for a retry.
- **Key set:** a group row with the key glyph, "Key ending digv" and a secondary "Remove"
  (class A), then the app list.

From chat, the Add to message sheet never shows the key form; with no key it offers "Set up
connectors in Settings" (1.3).

| State | Treatment |
|-------|-----------|
| Empty (no key) | Key form only, list hidden (board "Connectors, no key"). |
| Key rejected | Board "Connectors, key rejected". |
| Empty (no apps) | "No apps to show." / "No apps match "gmail"." (macOS copy). |
| Loading | Four row skeletons (logo tile, name bar, button block). |
| Error | Red line with Retry, as the Mac. |
| Connecting | Row button "Connecting" disabled, status "Waiting for approval in the browser", Safari sheet open. |
| Pressed, focus, active | Baseline. |
| Disabled | Connect disabled while another connect is pending, reason "Finish the other sign-in first". |
| Offline | List from cache; buttons disabled with reason. |

**Dynamic Type.** The button drops under the name and status.

---

### 1.14 Usage (push)

Mockup: "Usage". Renders the macOS pane: the one budget ("Tokens a day"), a stepper with "Lower the
daily limit" and "Raise the daily limit" accessibility labels (limit change class A), and the
week's traffic list by model with tabular figures.

| State | Treatment |
|-------|-----------|
| Empty | "No model traffic this week yet." (macOS copy). |
| Loading | "Loading usage." skeleton rows. |
| Other states | Baseline; limit change disabled offline with reason. |

**Dynamic Type.** Figures move under model names.

---

### 1.15 Devices (push)

Mockup: "Devices".

**Anatomy.** Groups:

1. "This Mac": Mac name, tailnet host (SF Mono 13, middle-truncated), status pill.
2. "Expiry": Session expires, Pairing expires (dates in the phone's zone).
3. "Diagnostics" (shown when `macUnreachable`): Resolved, TLS, HTTP status, each with an `ok` or
   `bad` pill.
4. Actions: "Sign out on this phone" (plain row), "Unpair" (`danger`, class A, confirm sheet
   explaining the purge).

| State | Treatment |
|-------|-----------|
| Credential expiring | Pairing row value in `warning` with "Re-pair from your Mac" under it. |
| Offline | Values from cache; Sign out still works (it works offline, spec 4.8). |
| Other states | Baseline. |

**Dynamic Type.** Host wraps to two lines instead of truncating at accessibility sizes.

---

### 1.16 Image viewer (full-screen modal)

Mockup: "Image viewer". Black background in both appearances (content viewing), image fit to screen,
pinch to zoom, swipe down to dismiss, top bar with close (44 pt) and Share. Chrome fades after
2 s idle; tap toggles it.

| State | Treatment |
|-------|-----------|
| Loading | `border` skeleton at the image's aspect ratio. |
| Error | "Couldn't load this image." with Retry, white text at 85%. |
| Other states | Baseline. |

**Dynamic Type.** Top bar controls keep 44 pt; labels scale.

---

### 1.17 Widget host (inline transcript row)

Mockup: "Widget host". Matches the macOS rendering: a lifted card, `Radius.lg`, full bubble column width,
height from the widget's frame message within bounds, created only when near the viewport.

| State | Treatment |
|-------|-----------|
| Loading | Skeleton at the requested height. |
| Error | The Mac's failure copy inside the card, with Reload. |
| WebKit crash | Reload once automatically, then the failure copy. |
| Other states | Baseline. |

**Dynamic Type.** The host frame does not scale; widget content handles its own type.

---

### 1.18 Signed out (state `signedOut`)

Mockup: "Signed out".

**Anatomy.** Centered block on `surface`: brand badge 56 pt, "Signed out", the Mac name in
`inkMuted` ("Mac Studio"), primary "Sign in" (class C), and a secondary "Unpair" (class A).
Cached data is not shown.

| State | Treatment |
|-------|-----------|
| Loading | "Signing in" on the primary. |
| Error | Reason line in `danger`; unreachable uses the pairing copy. |
| Offline | Sign in disabled with "You're offline". |
| Other states | Baseline. |

**Dynamic Type.** Buttons stack full width.

---

## 2. Reconciliation: mockups against the spec

"Mockup shows" records the first round of boards. Mockup wins on layout intent; the spec wins on
tokens, behavior, states and the blacklist. The canvas was redrawn on 2026-09-19 to the "Wins"
column, so every row below is now resolved on the boards.

| # | Topic | Mockup shows | Spec says | Wins | Why |
|---|-------|--------------|-----------|------|-----|
| R1 | Needs-approval signal | "Bots": a "Needs approval" warning pill on the Drive Admin row | 9.1: rows carry avatar, name, label and working state; pending approvals get one entry at the top of the list | Spec | Behavior. Remove the row pill; add the Approvals entry (1.2). |
| R2 | Row working state | "Bots": the label line replaced by the word "Working" | 9.1 working indicator from server state; the Mac animates the avatar and keeps the label | Spec (Mac) | Behavior parity. Breathing avatar, label kept, "Working" only under Reduce Motion. |
| R3 | Row preview, timestamp, unread | None drawn | None allowed | Agree | No change. |
| R4 | Approval card content | "Approval docked": bot plus one-line question, Deny and Approve | 9.2: bot, working directory, full scrollable preview, countdown, seven states, class A bound to the hash | Spec | Behavior and states. Card rebuilt per 1.3. Mockup layout (docked above the composer, buttons side by side) kept. |
| R5 | Approve button label | "Approve" | A.1: buttons name the exact action ("Approve command") | Owner | Owner decision 2026-09-19: "Approve" stays, because two side-by-side buttons on a phone need short labels. The card's preview names the action. |
| R6 | Lock glyph | Absent, although Drive Admin is Full access | 4.4 B, 9.2: lock glyph while a `full_access` bot is locked | Spec | Add the badge on Send (1.3). |
| R7 | Profile entry | Avatar button in the nav bar | 10: "profile row" on the Bots list | Mockup | Layout intent; the nav-bar avatar is the profile row's entry point. Same destination. |
| R8 | New bot and New group | "New bot": one sheet with a Bot / Group chat segment; "+" opens it directly | 10: "+ menu" with New Bot / New Group / New Section; separate sheets; New Group has member multi-select | Spec | Behavior. "+" opens a menu; each item opens its own sheet. |
| R9 | Folder chip | "My Drive" with a chevron, implying a picker | 9.3, F2: workspace read-only on the phone; attach blocked server-side | Spec | Chip without chevron; tap explains "Attach a folder from your Mac". |
| R10 | Readiness copy | "Mac asleep": "Your Mac is asleep. Bots pick up when it wakes." | 7.2: four levels; sleep, off-tailnet, Serve stopped all read as "Mac unreachable" with last-seen time | Spec | The phone cannot tell sleep from the other causes; honest copy. Banner layout kept. |
| R11 | Bot settings presentation | "Bot settings": a pushed screen | 10: a sheet | Spec | Navigation is behavior. Content layout of the mockup kept. |
| R12 | Bot settings content | Model, Permission, Working folder, "Notify when done", one routine, Memory, Delete | 9.3: name, label, description, avatar shape and color, permission, routines with states, memory; no push in v1 (14) | Spec | Add Profile and Avatar groups and past conversations; "Notify when done" removed (owner decision: no notifications in v1). |
| R13 | Pairing copy | "Enter code instead"; steps say "Settings, then This Mac, Pair a phone" | 6.1, 10: "Scan QR / Enter manually"; Mac path is Settings, Devices, "Show pairing QR" | Spec | Copy follows the real Mac path. Layout kept. |
| R14 | Connectors key | "Connectors" (from chat) omits the Composio key | 9.4: browse, key configuration, connect, disconnect | Spec, placed | Key lives on the Settings entry of Connectors; the in-chat sheet shows the list only and, with no key, a "Set up connectors in Settings" row. Closed in 6.2 item 3. |
| R15 | Settings structure | "Settings": Account, Appearance (with Language, Time zone), Bots, "This Mac" with Version | 9.4: General, Appearance, Providers, Connectors, Usage, Devices, About | Spec | Groups renamed and reordered per 1.11; "This Mac" becomes Devices; Version moves to About. |
| R16 | Provider detail | "Providers": list only, a "Reviewer" task model removed earlier | 9.4, 10: provider detail push per mode | Spec | Detail screen specified in 1.12. |
| R17 | Search | "Search": inline page, bot results only; empty copy "No matching bots." | 9.1, 10: sheet; scope includes labels, descriptions, sections, recent conversation titles; grouped by bot | Spec | Behavior and copy ("No matching chats or bots."). Field-on-top layout kept. |
| R18 | Empty chat copy | "New chat": title only | 9.2: everyday prompt tiles (was the permission-aware copy until 2026-09-29) | Spec | Add the `StarterPrompt.everyday` tiles under the title, centered. Centered layout kept (owner request). |
| R19 | Model chip placement | Inside the composer, right of "+", left of Send | 9.2: pickers as iOS menus or sheets (placement unstated) | Mockup | Owner-approved layout. |
| R20 | Sheet shape | Floating sheets, all corners rounded (owner request) | A.5: sheet detents per content | Both | Floating shape from the mockup, detents from the spec. |
| R21 | Signed-out and credential-invalid | No mockups | 10 screen 18, 4.8 | Spec | Defined in 1.18 and 1.1; boards "Signed out" and "Pair again" added. |
| R22 | Dark mode | Only one dark chat board | F4, A.7: both appearances for every screen | Spec | Every board now has a dark twin. |
| R23 | Dark scrim | `rgb(0 0 0 / 0.5)` in dark boards | A.2: solid `rgb(23 23 23 / 0.18)` | Closed 6.2 item 2 | Light keeps the token; dark uses `#000000` at 48% because the token leaves sheets indistinguishable from the dark stage. |
| R24 | Font sizes | 16 pt body, 17 pt titles, 22 pt large title, 26 pt empty title | 12: `DesignTokens.swift` is the authority for sizes | Spec | Body 15 (`chatBody`), empty title 28 (`emptyTitle`); the iPhone additions in 4.3 are owner-approved. |
| R25 | Group rows in dark | `#1B1B1B` | Token set has no such value | Spec | Groups use `surface #171717` on `canvas #0F0F0F`. |
| R26 | Missing screens | Past conversation, Group settings, Pending approvals, Usage, Devices, Image viewer, Widget host, Signed out, Rename, Move, Delete confirm | 10 | Spec | Specified in section 1; boards added for each. |
| R27 | Routine states | Active toggle, days, time, zone, Test run, history | 9.3: enabled, paused, running, last run ok or failed, next run time, footer copy | Spec | Add next run line, running and failed states, and the ticking footer. |

---

## 3. Blacklist violations inside the mockups

Rules cite Appendix A. Each item names the first-round board; all are fixed on the redrawn
canvas.

| # | Board | Violation | Rule | Fix |
|---|-------|-----------|------|-----|
| V1 | "Bots", "Model and effort", "Settings", "Bot settings", "Providers" | Section and group titles ("Unassigned", "ChatGPT", "Appearance") in `inkFaint #A3A3A3`, 2.3:1 on canvas | A.7 contrast | `inkMuted`. |
| V2 | "Chat, bot working" and all chat boards | "Today" divider label in `inkFaint` | A.7 | `inkMuted`. |
| V3 | "Bots", "Search", chat boards | Placeholders ("Search", "Message Drive Admin", "Search models", "What should Invoice Clerk work on first?") in `inkFaint` | A.7 | **new** `inkFaintText`. |
| V4 | "Connecting" | "Connecting to MacBook Pro" is `inkMuted` (passes); its dot is `inkFaint` | None (decorative) | Keep. Listed to show it was checked. |
| V5 | Chat boards, sheets | Composer "+" (36 pt), Send (36 pt), session chips (36 pt), segmented segments (30 pt), small buttons (34 to 40 pt) drawn below 44 pt | A.7 touch targets | Keep glyph sizes; hit areas 44 pt. |
| V6 | "Connectors" | The app list sits in a bordered, tinted container inside the sheet: a card inside a card | A.1 cards in cards, A.2 one level | Flat list with inset hairlines directly on the sheet. |
| V7 | "Search" | Match highlight is a gray block with a one-off 3 to 4 pt radius | A.2 radius scale | Semibold `ink` for matched characters, no block. |
| V8 | "Chat, dark" and dark CSS | Non-token dark values: group `#1B1B1B`, picked segment `#3A3A3A`, custom shadow `0 1px 2px rgb(0 0 0 / .4)` | 12 tokens are the authority; A.2 | Groups `surface`, picked segment `sunken` (a visible step on the `border` track), lift by `edge` plus tone step. |
| V9 | Dark boards | Scrim `rgb(0 0 0 / 0.5)` | A.2 scrim | Light: token. Dark: `#000000` at 48% (closed 6.2 item 2). |
| V10 | "Approval docked" | "Approve" does not name the action | A.1 copy | Waived by the owner (R5). |
| V11 | "Pair with Mac" | Numbered steps | A.1 numbered markers | No violation: the steps are genuinely sequential. Listed to show it was checked. |
| V12 | "Failed turn" | `dangerSoft` card with a 25% danger edge | A.2 warning card recipe asks for 40% | Edge at 40%. |
| V13 | Group chat boards (second round) | Bot attribution rows ("YT Producer" above a bubble) in `inkFaint`, 2.3:1 | A.7 contrast | `inkMuted`, as 1.3 already specifies for bot-meta rows. Fixed. |
| V14 | "Connectors, no key", "Pair, camera denied", "Connectors" (second round) | Disabled primary buttons drawn as the black fill at 55% opacity, white label about 3.4:1 | A.2 disabled rule, A.7 | Disabled is the quiet `sunken` fill with an `inkFaint` label plus a reason line. Fixed on every board. |

Checked and clean across all boards: no gradients beyond the permitted 1 to 3% sheen (the send
button's top sheen is the macOS value and counts as finish under A.2),
no extra accents, no purple family, no decorative color, no spring motion, no emoji icons, no
platform segmented control (all segments are drawn token controls), no hype copy, no
exclamation marks.

---

## 4. Token mapping and contrast

### 4.1 Colors

Hex values from `DesignTokens.Hex` (light) and `DesignTokens.DarkHex` (dark). "Used for" is the
iOS role.

| Token | Light | Dark | Used for |
|-------|-------|------|----------|
| `canvas` | `#F3F3F3` | `#0F0F0F` | List and grouped-settings background, sheet background for grouped sheets |
| `rail` | `#F3F3F3` | `#0F0F0F` | iPad sidebar |
| `surface` | `#FFFFFF` | `#171717` | Chat stage, groups, cards, floating sheets, nav bars |
| `sunken` | `#F0F0F0` | `#2C2C2C` | User bubbles, secondary buttons, picked option rows, "+" circle, disabled send, code blocks |
| `bubbleBot` | `#FFFFFF` | `#202020` | Bot bubbles, composer field |
| `ink` | `#171717` | `#EDEDED` | Primary text, glyphs of primary controls |
| `inkMuted` | `#5C5C5C` | `#A3A3A3` | Secondary text, section titles, meta, reasons |
| `inkFaint` | `#A3A3A3` | `#6E6E6E` | Decorative marks, disabled glyphs, chevrons only. Never readable text |
| `inkFaintText` (**new**, add to `DesignTokens.swift`) | `#6B6B6B` | `#949494` | Placeholders and tertiary readable text. Confirmed on every surface, see 4.2 |
| `brand` | `#171717` | `#EDEDED` | Primary button fill, send fill, toggle on, picked day |
| `brandInk` | `#FAFAFA` | `#141414` | Text and glyph on `brand` |
| `accent` | `#171717` | `#EDEDED` | Focus ring, active state |
| `accentStrong` | `#0A0A0A` | `#FFFFFF` | Pressed primary |
| `accentSoft` | `#F0F0F0` | `#262626` | Icon button pressed |
| `accentInk` | `#FFFFFF` | `#141414` | Text on accent |
| `border` | `#EBEBEB` | `#262626` | Hairlines, segmented track, skeletons |
| `borderStrong` | `#E0E0E0` | `#333333` | Field edges, focused composer edge, grabber |
| `scrollKnob` | `#E3E3E3` | `#3A3A3A` | Scroll indicator (5 pt, 3 pt from edge, fades after 0.7 s) |
| `scrollKnobActive` | `#D4D4D4` | `#4A4A4A` | Scroll indicator while dragged |
| `success` / `successSoft` | `#0F6F56` / `#E4F4EE` | `#4CC39B` / `#13302A` | "Connected", "Approved", "Done" |
| `warning` / `warningSoft` | `#8A5300` / `#FBF1DE` | `#E3A64A` / `#33260F` | Approvals entry pill, expiring, changed |
| `danger` / `dangerSoft` | `#B23C22` / `#FBEAE5` | `#F0795C` / `#3A1B14` | Errors, destructive rows, failed |
| `edge` (NativeTheme) | black 5% | white 7% | Whisper edge on lifted surfaces |
| `overlay` (scrim) | `#171717` at 18% | `#000000` at 48% (**new** `overlayDark`) | Sheet scrim. The dark value replaces the token in dark only (closed item 2) |
| `thumbBadge` | `#171717` at 72% | same | Badges over images |

### 4.2 Contrast (WCAG 2.x, text on the surface it sits on)

Computed from the hex values. Below 4.5:1 is a violation (A.7), marked **fail**.

**Light**

| Text | on `surface` #FFF | on `canvas` #F3F3F3 | on `sunken` #F0F0F0 | on its soft fill |
|------|------|------|------|------|
| `ink` | 17.93 | 16.16 | 15.73 | |
| `inkMuted` | 6.69 | 6.03 | 5.87 | |
| `inkFaint` | 2.52 **fail** | 2.27 **fail** | 2.21 **fail** | |
| `inkFaintText` (new) | 5.33 | 4.80 | 4.68 | 4.69 on `successSoft`, 4.76 on `warningSoft`, 4.57 on `dangerSoft`, 4.68 on `accentSoft` |
| `success` | 6.13 | 5.52 | 5.37 | 5.39 on `successSoft` |
| `warning` | 6.33 | 5.70 | 5.55 | 5.65 on `warningSoft` |
| `danger` | 5.89 | 5.31 | 5.17 | 5.05 on `dangerSoft` |
| `brandInk` on `brand` | 17.18 | | | |

**Dark**

| Text | on `surface` #171717 | on `canvas` #0F0F0F | on `sunken` #2C2C2C | on `bubbleBot` #202020 | on its soft fill |
|------|------|------|------|------|------|
| `ink` | 15.31 | 16.37 | 11.93 | 13.92 | |
| `inkMuted` | 7.11 | 7.60 | 5.54 | 6.46 | |
| `inkFaint` | 3.52 **fail** | 3.76 **fail** | 2.74 **fail** | 3.20 **fail** | |
| `inkFaintText` (new) | 5.91 | 6.32 | 4.60 | 5.37 | 4.67 on `successSoft`, 4.86 on `warningSoft`, 5.14 on `dangerSoft`, 4.99 on `accentSoft` |
| `success` | 8.18 | 8.75 | 6.38 | 7.44 | 6.46 on `successSoft` |
| `warning` | 8.38 | 8.96 | 6.53 | 7.62 | 6.89 on `warningSoft` |
| `danger` | 6.48 | 6.93 | 5.05 | 5.89 | 5.64 on `dangerSoft` |
| `brandInk` on `brand` | 15.74 | | | | |

Rule: `inkFaint` fails everywhere as text and is used only for decoration and disabled glyphs.
Non-text controls (3:1): the `borderStrong` field edge against `surface` is 1.3:1 in light, so
fields also carry their label and a focus ring; the focus ring (`accent`) is 17.9:1.

### 4.3 Radius, type, space, shadow and motion

**Radius** (`DesignTokens.Radius`): `xs` 6 focus rings and tiny chips; `sm` 10 buttons, icon
buttons, menu rows, logo tiles; `md` 14 fields, groups, bubbles, small cards, 50 pt buttons;
`lg` 16 cards, approval cards, pinned card; `xl` 22 composer and floating sheets; `xxl` 24
unused on iPhone; `pill` 999 search pill, status pills, avatars, day circles.

**Type** (SF Pro via the system font, each wrapped with `relativeTo:`; SF Mono for code):

| Role | Token | pt | Weight |
|------|-------|----|--------|
| Chat body, bubbles, list values | `FontSize.chatBody` | 15, line height `chatLineHeight` 24 | regular |
| Bot and person names, row titles | `FontSize.chatName` | 15 | semibold |
| Meta, day divider, bot-meta rows | `FontSize.chatMeta` | 11 (12 on iPhone, approved) | regular |
| Row label (role) | `FontSize.railLabel` | 10, uppercase, tracking `label` 0.04 (11 on iPhone, approved) | medium |
| Section and group titles | `FontSize.fieldLabel` | 13 | medium |
| Fields | `FontSize.fieldInput` | 14 (15 on iPhone, approved) | regular |
| Buttons | `FontSize.button` | 14 | semibold |
| Chips | `FontSize.modeChip` | 13 | regular, value semibold |
| Sheet titles | `FontSize.dialogTitle` | 16 | semibold |
| Empty title | `FontSize.emptyTitle` | 28, tracking `tight` | semibold |
| Empty body | `FontSize.emptyBody` | 15 | regular |
| Proposal and status cards | `proposalTitle` 11, `proposalName` 15, `proposalBody` 13 | | |
| Nav title (**new** `phoneNavTitle`) | | 17 | semibold |
| Bots list title (**new** `phoneLargeTitle`) | | 22 | semibold |

**Space** (`DesignTokens.Space` where it fits, **new** where the phone needs its own):
`bubbleStackGap` 6; `composerTop` 8; `scrollbarWidth` 5; **new** `phoneGutter` 16,
`phoneTranscriptGap` 16, `phoneRowMinHeight` 60, `phoneHitTarget` 44, `sheetInset` 8.

**Controls** (`DesignTokens.Control`): `buttonMinHeight` 40 raised to 44 for touch;
`composerButton` 32 drawn at 36 inside a 44 target; `operatorAvatar` 32; `composerExpandedMax`
160; `facePreview` 80 (84 in the mockup; use 80). The system switch is replaced by the drawn
toggle at 51 by 31 pt (the Mac's 36 by 22 is too small for touch; approved).

**Shadows** (`DesignTokens.Shadow`, color `shadow` = ink, dark in both appearances):

| Token | y | blur | spread | opacity | Used for |
|-------|---|------|--------|---------|----------|
| lift (NativeTheme `cardLift`) | 0.5 and 3 | 1 and 16 | 0 | 4% and 8% | Bubbles, pinned card, approval and status cards, banners |
| `sm` | 1 | 2 | 0 | 4% | Primary buttons, send |
| `raiseTop` + `raise` | 1 + 22 | 0 + 44 | 0 + -22 | 4% + 22% | Composer |
| `pop` | 24 | 56 | -28 | 28% | Floating sheets |
| `card`, `cardTop` | | | | | Unused on iPhone |

**Motion** (`DesignTokens.Motion`, one curve `cubic-bezier(0.22, 1, 0.36, 1)`): `fast` 0.15 s
press and control surfaces; `overlay` 0.2 s scrim fade; `dialog` 0.25 s sheet rise; exits 0.12 s;
page swap two beats (0.12 s recede with -6 pt, 0.26 s rise with 8 pt); skeleton and working
breath 1.6 s; `scrollFade` 0.22 s. No springs. Reduce Motion turns all of these into instant
swaps and static frames.

---

## 5. Components and reuse boundaries

One component rendered in several states is listed once. Genuinely different components are
separate. SwiftUI names are the build's.

| Component (SwiftUI view) | One component, N states | Used on |
|--------------------------|-------------------------|---------|
| `BotAvatarView` | Sizes 20, 28, 32, 40, 44, 64, 72, 80; static or breathing (working); Reduce Motion frame | Everywhere |
| `AvatarStackView` | Two or three faces | Group rows, group settings |
| `BotRowView` | Default, pressed, working, active (iPad), offline | Bots list, search, pickers |
| `PinnedBotCard` | Default, pressed, working | Bots list |
| `SectionHeaderView` | Expanded, collapsed | Bots list |
| `ApprovalsEntryRow` | Count, cached | Bots list |
| `ReadinessBanner` | Four levels plus credential expiring; lifted (lists) or flat strip (chat) | Bots list, chat, pending approvals |
| `TranscriptView` | Loading, streaming, empty, cached | Chat, past conversation |
| `UserBubbleView` | Default, confirming, not sent, folded | Chat |
| `BotBubbleView` | Default, stacked | Chat |
| `DayDividerView` | | Chat |
| `BotMetaRow` | | Chat |
| `WorkingRow` | Activity label, elapsed, reduce motion | Chat |
| `StatusCardView` | Done, Added, PR, proposal, failed turn, owner question: title, body, pill, actions | Chat |
| `ApprovalCardView` | Pending, approving, approved, denied, expired, resolved on your Mac, changed | Chat dock, focused from Pending approvals |
| `AsksDockView` | One card, stacked "N more waiting" | Chat |
| `ComposerView` | Idle, typing, sendable, streaming (stop), locked, disabled with reason, confirming | Chat |
| `ModelChip` | | Composer |
| `SessionChip` | Folder (read-only, "No folder" variant in `inkMuted`) and permission are one view with an `interactive` flag | Under composer |
| `MentionSuggestionList` | Full, filtered, no match, largest text; highlight row | Group chat composer dock |
| `FolderInfoSheet` | Folder attached, no folder | Opened by the folder chip |
| `ConnectorsKeyForm` | No key, rejected, saving; set state is a settings row | Settings, Connectors |
| `FloatingSheet` | Medium, large, smallest-fit detents; internal push; scrim `overlay` light, `overlayDark` dark | Model, Permission, Add to message, Connectors, Working folder, create flows, confirms |
| `OptionRow` | Picked (sunken card plus check) or not; with icon tile and consequence line or plain | Model, Permission, Move to section, member picker |
| `TokenSegmentedControl` | 2 to 4 options; vertical list at accessibility sizes | Effort, theme, routine schedule |
| `TokenToggle` | On, off, disabled | Settings, routines, speed |
| `SettingsGroup` + `SettingsRow` | Value, chevron, toggle, field, destructive | All settings screens |
| `FieldShell` | Default, focused, error, secure | Forms |
| `NativeButton` | Kinds: primary, secondary, destructive; sizes: regular 50, small 36 in 44; states: pressed, disabled with reason, busy | Everywhere |
| `IconButton` | 44 pt target, glyph 20 to 26 | Nav bars, sheets |
| `StatusPill` | ok, warn, bad, quiet | Rows, cards |
| `SkeletonBlock` | Bar, circle, bubble, row | Loading states |
| `EmptyStateView` | Title plus body, left or centered | Lists, chat |
| `ConnectorRow` | Connected, not connected, no sign-in, connecting, timed out | Connectors |
| `ProviderRow` | Connected, rejected, not connected | Providers |
| `RoutineRow`, `RunHistoryRow` | Active, paused, running, failed | Bot settings, routine editor |
| `DayPickerView` | | Routine editor |
| `QRScannerView` | Scanning, frozen, denied | Pairing |
| `SafariSheet` | Wraps `SFSafariViewController` | OAuth flows |
| `ImageViewer` | | Attachments |
| `WidgetHostView` | Loading, ready, failed, reloading | Chat |
| `ToastView` | Conflict, forbidden | Chat, lists |
| `BiometricGate` (modifier, not a view) | Class A, class B, passcode unavailable | Every gated action |

Genuinely different, never merged: `ApprovalCardView` and `StatusCardView` (the approval card
owns security binding and seven states; merging them would let a status card render an approve
action). `ReadinessBanner` and `ToastView` (persistent state versus a one-off event).
`BotRowView` and `ConnectorRow` (different trailing controls and semantics).

---

## 6. Owner decisions and closed items

### 6.1 Decided on 2026-09-19

- **Approve label:** stays "Approve", not "Approve command". Two buttons share one phone row,
  and the card's preview already names the action. This waives A.1's example for this button.
- **No notifications in v1:** "Notify when done" is removed from Bot settings. No in-app
  substitute.
- **iPhone-only sizes are approved** as shared tokens: `phoneNavTitle` 17, `phoneLargeTitle`
  22, meta 12, row label 11, field input 15, the 51 by 31 toggle, and the space additions in
  4.3 (`phoneGutter` 16, `phoneTranscriptGap` 16, `phoneRowMinHeight` 60, `phoneHitTarget` 44,
  `sheetInset` 8). The build adds them to `DesignTokens.swift` in PR-1.
- **Mockups follow this document.** Every screen in section 1 has a board, with a dark twin.

### 6.2 Closed on 2026-09-19

All five items were decided within the spec and drawn. Nothing is left open.

1. **`inkFaintText` confirmed:** `#6B6B6B` light, `#949494` dark. Every pair clears 4.5:1; the
   lowest are 4.57:1 (light, on `dangerSoft`) and 4.60:1 (dark, on `sunken`). Full ratios in
   4.2. It is a new token for `DesignTokens.swift`. Boards: every placeholder, for example
   "Bots" (search field) and "New bot" (First brief).
2. **Dark scrim:** the token (`#171717` at 18%) is kept as law in light. In dark it fails: over
   the `#171717` stage the backdrop does not move, so a sheet reads only by its 7% edge (board
   "Dark: token scrim 18% (rejected)"). Dark uses `#000000` at 48% (**new** `overlayDark`),
   which drops the stage to about `#0C0C0C` under the `#171717` sheet. The pair: light
   `#171717` at 18%, dark `#000000` at 48%. This extends A.2, which did not address dark.
   Boards: every dark sheet, for example "Dark: Permission".
3. **Connectors key placement:** the key lives only in Settings, Connectors, in three states
   (1.13). The chat's Add to message sheet shows "Set up connectors in Settings" when no key is
   saved, and tapping it opens Settings, Connectors on the key form. Boards: "Connectors, no
   key", "Connectors, key rejected", "Connectors, key set", "Add to message, no key".
4. **Group chat @mentions:** an inline suggestion list docked above the composer, specified in
   1.3 (trigger, candidates, anchor, four-row cap, row anatomy, insert, keyboard, VoiceOver,
   empty result, largest text, dark). Boards: "Mention list", "Mention list, filtered",
   "Mention list, no match", "Mention list, largest text", and their dark twins.
5. **Folder chip with no folder:** the chip reads "No folder" in `inkMuted` and opens the
   Working folder sheet with "No folder attached" and "Attach a folder from your Mac. This
   iPhone can't change it." Boards: "New chat", "Folder sheet, no folder", "Folder sheet".
