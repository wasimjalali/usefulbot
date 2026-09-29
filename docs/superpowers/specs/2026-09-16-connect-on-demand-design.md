# Connect on demand

Date: 2026-09-16. Status: design, awaiting owner review.

Sub-project 1 of 3. Sub-project 2 is MCP and OpenAPI connections for bots
(Excalidraw first). Sub-project 3 is the native mobile app, deferred to its own
session: SwiftUI on `UsefulBotCore` (no AppKit imports there today), same
experience as the desktop app, the Mac stays the always-on host. The Telegram
and Tailscale phone paths are cancelled.

## Goal

A bot that needs an app the owner hasn't connected yet asks for it in the chat,
the owner authorizes with one click, and the bot picks the task back up on its
own. Today the bot can only say "connect it in Connectors and ask me again".

Reference: Grok's flow (status check, offer, auth card with Authorize, Waiting
with Reopen, Added pill with tool count, bot resumes). We do it in one card with
three states, in our own tokens, docked above the composer like every other ask.

## Scope

In: the two bot tools, the new proposal kind, confirm and watch on the server,
the macOS card, tests, screenshots.

Out: the web UI card (secondary surface, not ported, said so in the PR), apps
outside the Composio catalogue (sub-project 2), the Composio API key step (a
missing key is still a Connectors settings step, the bot says so and stops).

## MCP variants in the catalogue

Composio lists an MCP variant beside many apps (`notion_mcp` "Notion MCP" next
to `notion`; 116 of the 1534 toolkits). Once connected, its tools already flow
through `connector_search` and `connector_execute` like any toolkit. The only
gap is discovery: `listConnectorToolkits` in `shared/composio.ts` drops every
`_mcp` row that isn't connected, so the dialog search never shows "Notion MCP"
and a bot could not propose it.

Change: remove the `_mcp` hide. Both rows show in the Connectors dialog and in
`connector_catalog`, plain app first (the ranking already sorts "Notion" before
"Notion MCP" on a tie). Nothing else about the rows changes: same connect and
disconnect, same logo, the name Composio gives already carries "MCP".

Instructions: prefer the plain connector; propose the MCP variant when the
owner asks for MCP or when the plain app's tools don't cover the task.

Out of scope, noted for later: the 18 no-auth MCP toolkits (and no-auth apps
in general) stay hidden because the connected-toolkit gate in
`searchConnectorTools` cannot admit an app that never connects.

## Bot side

### `connector_catalog` (new tool, `agent/tools/connector_catalog.ts`)

Input: `query` (3 to 80 chars). Output: up to 8 matches from the cached
catalogue (`~/.useful-bot/composio-catalogue.json`) with `slug`, `name`,
`connected`, plus `hasKey`. Read-only, never carded, works with zero apps
connected. Scoring reuses `listConnectorToolkits` in `shared/composio.ts` so
the bot and the dialog rank the same way, MCP variants included; no-auth
toolkits stay hidden. No key: `{ status: "blocked", error: "connectors_not_set_up" }`.
Catalogue not built yet: `listConnectorToolkits` already falls back to a live
Composio search, so the tool returns whatever that gives.

### `propose_connector` (new tool, `agent/tools/propose_connector.ts`)

Input: `slug` (must be a catalogue slug, validated server-side), `purpose`
(one line, max 120 chars, what the bot will do there), optional `requestId`
for idempotency like `propose_bot`. Creates a `connectApp` proposal on the
calling bot's thread, appends a `proposal` agent event, returns
`{ status: "awaiting_owner_confirmation", proposalId }`. Refused with
`already_connected` when the app is active, and with `duplicate` when an open
`connectApp` card for the same slug exists.

### Instructions (`agent/instructions.md`, connectors section)

Replace "tell the owner which app to connect in Connectors and stop" with:

1. When a task needs an app, or a connector call comes back `not_connected` or
   `no_connectors`, call `connector_catalog` with the app name.
2. Found and not connected: call `propose_connector` once, then end the turn
   with one line, e.g. "Authorize Gmail on the card and I'll pick it up from
   there." Never propose two apps in one turn; never try another app instead.
3. Not in the catalogue: say so in one line and stop (sub-project 2 will add
   the MCP and OpenAPI path here).
4. When a turn arrives that says the owner connected the app, continue the
   original task without asking again.

## Server side

### Store (`shared/agent-store.ts`)

```ts
export type ConnectAppProposal = {
  kind: "connectApp";
  slug: string;
  name: string;
  logo: string | null;
  purpose: string;
  sourceBotId: string | null;
  threadId: string;
  phase: "proposed" | "waiting" | "connected" | "expired";
  accountId: string | null;   // Composio connected-account id once authorize ran
  waitingSince: string | null;
  toolCount: number | null;   // filled when connected, null if the count call fails
  handoffId: string | null;   // the resume handoff once queued; the card leaves when it lands
};
```

`status` keeps its existing meaning: `pending` while the card is on screen in
any phase, `confirmed` once the bot has been handed the resume, `dismissed` on
Not now. `openProposals` in the app therefore includes waiting and connected
cards until the resume is queued.

### Confirm (`web/app/api/shell/route.ts`, PUT)

A `connectApp` proposal confirms with `{ proposalId, proposalStatus: "confirmed", action: { type: "connectApp", slug } }`.
`proposalMatchesAction` checks the slug. Instead of a shell mutation the route
calls `authorizeConnector(slug, callbackUrl())`, stores `accountId`, sets
`phase: "waiting"` and `waitingSince`, leaves `status: "pending"`, and returns
`{ ok, store, redirectUrl }`. The URL is returned once and never stored.
Reopen is the same call again on a waiting card: a fresh authorize, new
`accountId`. Dismiss works in every phase and is the existing dismiss path.

Desktop gate, CSRF header and the shell rate bucket apply unchanged. The bot's
tool cannot start OAuth: only a card confirm reaches `authorizeConnector`.

### Watch (`web/lib/agent-exec.ts`, called from the tick route)

`pumpConnects()` runs on every `POST /api/agent/tick` next to `pumpHandoffs`
and `pumpRoutines`. For each `connectApp` proposal in `waiting`:

- At most one Composio check per card per 5 s (memo keyed by proposal id).
- Check: `listConnectorToolkits({ search: name, limit: 5 })` and find the row
  by slug. `connected === true` means active.
- Active: `toolCount` from `tools.getRawComposioTools({ toolkits: [slug], limit: 200 }).length`
  (null on failure, never blocks). Set `phase: "connected"`, append a `note`
  event "Gmail connected" on the thread, then queue one handoff through
  `sendHandoff` from `bot-useful` to the source bot:
  "The owner connected the app gmail. Continue the task: <purpose>" (the app
  is named by its validated slug, never by the catalogue display name, which
  is data, not an instruction), store its id on the card and turn the card
  `confirmed` at once, so it leaves the dock the moment the resume is queued
  (owner decision on 2026-09-16 after seeing the pill wait for the whole
  reply). A card whose resume could not be queued stays Connected with Not
  now, is retried each tick, and leaves after ten minutes regardless.
  Queueing is idempotent: a resume with the same message from this cycle is
  adopted, and the pump is single-flight like the handoff pump.
- The resume runs as a background turn. The macOS transcript hides the
  handoff envelope the pump sends (it is plumbing, not an owner message; the
  "Gmail connected" note row and the bot's reply tell the story), and the
  session follower publishes a background working state so the same working
  row shows while the bot continues. The card stays `pending` in phase `connected` (the pill is on
  screen) until that handoff is delivered or has given up, then turns
  `confirmed` and leaves the dock; ten minutes is the cap if the resume never
  lands. The handoff record is the resume; it survives an app restart the same
  way teammate handoffs do.
- Waiting for more than 10 min: `phase: "expired"`. The card shows "Sign-in
  timed out" with Reopen and Not now. No handoff.
- Dismissed while waiting: no revoke. A half-finished OAuth that later
  completes shows up in Connectors as usual; nothing resumes the bot.

The app's poll already republishes the store, so the card changes state within
one poll of the tick that saw it.

## macOS card (`ProposalCardView.swift`, `Proposal.swift`)

New `Kind.connectApp` decoded with `slug`, `name`, `logo`, `purpose`, `phase`,
`toolCount`. Card title "Connect app". Body row: `AppLogo` (moved out of
`RootView.swift` into its own file so both views share it) at 28 pt, name in
15 semibold, purpose in 13 muted below it.

- proposed: actions row Authorize (primary) and Not now.
- waiting: `ProgressView` at 12 pt plus "Waiting for Gmail sign-in" in 13 muted
  on the left, Reopen (secondary, small) on the right. Not now stays.
- connected: green pill "Connected" (checkmark, `Theme.C.success` soft
  background) and "31 tools" in 12 faint when `toolCount` is set, plus Not
  now. Normally seen for one poll at most: the card leaves the dock as soon as
  the resume is queued, and the working row takes over.
- expired: "Sign-in timed out" in 13 warning, Reopen and Not now.

`decideProposal` gains the connect path: confirm returns `redirectUrl`, the
model opens it with `NSWorkspace.shared.open` and applies the returned store.
Reopen reuses the same call. `ProposalActions.confirm` returns
`{ type: "connectApp", slug }`.

Web UI: `proposal-card.tsx` renders the new kind as unsupported with Dismiss,
same as an unknown kind today. Not ported.

## Copy

Card title "Connect app". Buttons "Authorize", "Not now", "Reopen". States
"Waiting for {name} sign-in", "Connected", "{n} tools", "Sign-in timed out".
Transcript note "{name} connected". No em dashes, no helper text.

## Security notes

- Slug validated against the cached catalogue on propose and again on confirm.
- The redirect URL and the Composio key never reach the model or the store.
- Confirm needs the desktop session and CSRF; the tick route keeps its key or
  session auth; `pumpConnects` makes no writes to Composio beyond the tool list.
- The resume handoff carries only the purpose line the bot wrote itself, marked
  as owner-triggered (`depth: 0`).

## Testing

Node (`test/connector-tools.test.ts`, `test/agents.test.ts`, new
`test/connect-pump.test.ts`, all on the stubbed `setComposioFactory`):

- catalog: ranks by name, shows `_mcp` rows after the plain app, hides no-auth
  rows, reports connected, blocks without a key. `listConnectorToolkits` test
  updated for the visible MCP rows.
- propose: creates the card, refuses an unknown slug, an already-connected app
  and a duplicate open card, honours `requestId`.
- confirm: waiting phase set, `accountId` stored, URL returned once, CSRF and
  gate failures rejected, reopen issues a new `accountId`.
- pump: active account turns the card connected, writes the note, queues one
  handoff exactly once across repeated ticks; 10 min turns it expired; a
  dismissed card is never resumed; tool count failure leaves `toolCount` null.

Swift (`UsefulBotCoreTests`): `Proposal` decodes `connectApp` in every phase
and an unknown phase falls back to `unknown` kind.

Verification: real screenshots of the running app with a real catalogue app,
one per state (proposed, waiting, connected), plus the bot's resumed turn.
