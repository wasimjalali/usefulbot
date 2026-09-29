# MCP and OpenAPI connections

Date: 2026-09-16. Status: design.

Sub-project 2 of 3. Sub-project 1 (connect on demand, PR #63) shipped the
`connectApp` card. Sub-project 3 is the native mobile app, still deferred.

## Goal

When a bot needs an app that is not in the Composio catalogue, it can still
get it. The owner approves a server on a card in the chat. eve 0.54 already
speaks MCP and OpenAPI connections. This work puts an owner-approved registry
in front of that, with Excalidraw as the first entry.

Prefer the plain Composio connector when the app is in the catalogue. This
path is the fallback.

## Drawing in the chat (decision)

Excalidraw's official hosted server (`https://mcp.excalidraw.com/mcp`, no
auth, source github.com/excalidraw/excalidraw-mcp) is an MCP App. `create_view`
declares `_meta.ui.resourceUri = "ui://excalidraw/mcp-app.html"`. The tool
result is a checkpoint id. The drawing itself is the HTML widget, driven by
the tool input (`elements` JSON) over the MCP Apps `postMessage` protocol.

**Choice: render the widget in a WKWebView block in the transcript.** Saving a
`.excalidraw` file and a PNG would not show the drawing in the chat
(`ChatMarkdownView` has no image rendering, and the official server does not
expose a model-facing PNG export). The widget is how this server is meant to
be seen.

How it works:

1. The stream sees a connection tool with `_meta.ui.resourceUri` (or a
   `create_view` / `elements` input). The projection grows a widget row.
2. The host page (`GET /api/connections/widget/:id`) loads the `ui://` HTML
   in a sandboxed iframe and speaks the MCP Apps JSON-RPC: `ui/initialize`,
   then `ui/notifications/tool-input` with the stored arguments, then
   `ui/notifications/tool-result`.
3. The HTML is fetched through our MCP JSON-RPC helper against the registry
   URL (SSRF-guarded). It is stored under `~/.useful-bot/widgets/` (mode 0600),
   not in the transcript (the bundle is hundreds of KB).
4. A durable `widget` agent event points at that id so a reload still shows
   the drawing. The drawing is read from the validated call in
   `actions.requested` and keyed by eve's `callId`. Input chunks
   (`action.input.appended`, one event per chunk, partial JSON) are not drawn,
   so there is no partial streaming yet.
5. The app fetches the host page with its own session and hands it to the
   WKWebView as a string. The web view holds no cookie and may only navigate
   to `about:` pages. The host page carries the same CSP allowlist as the app,
   because a `srcdoc` frame inherits its parent's policy. The inner iframe may fetch
   origins the resource declared in `_meta.ui.csp` (Excalidraw needs
   `https://esm.sh`). No native bridge besides size-changed. `ui/open-link`
   is refused unless the URL is https on a public host, and then it opens
   in the system browser with the same host check as the connect card.

The PNG path stays out. A later host can add export if the official server
grows a model-facing image tool.

## Scope

In: the registry, eve `defineDynamic` wiring, `propose_connection`, the
`connectServer` card, MCP OAuth, Keychain secrets, Excalidraw seed, the
WKWebView widget host, tests, screenshots.

Out: the web UI card (unsupported with Dismiss, said so in the PR), the
native mobile app, Telegram, Tailscale, changes to the Composio
`connectApp` flow beyond reuse of its patterns.

## Registry

File: `~/.useful-bot/connections.json`. Same style as `shared/connectors-store.ts`:
atomic write, mode 0600, directory 0700, parse tolerant of unknown keys, a
corrupt file is moved aside.

```ts
export type ConnectionKind = "mcp" | "openapi";
export type ConnectionAuthKind = "none" | "apiKey" | "bearer" | "oauth";

export type ConnectionEntry = {
  id: string;                 // [a-z][a-z0-9-]{0,63}
  kind: ConnectionKind;
  name: string;
  url: string;                // already passed assertConnectionUrl
  description: string;        // for the model / connection_search
  authKind: ConnectionAuthKind;
  authHeader: string | null;  // apiKey header name, default X-Api-Key
  toolsAllow: string[] | null;
  createdAt: string;
};

export type ConnectionsStore = {
  schemaVersion: 1;
  connections: ConnectionEntry[];
  updatedAt: string | null;
};
```

No secrets in the JSON. Tokens, API keys and OAuth client secrets live in
Keychain as `com.usefulbot.connection.{id}` (account `useful-bot`), written
the same way `scripts/setup-local.mjs` writes (`security -i`, never on argv).
OAuth token bundles are JSON inside that item: access token, refresh token,
expiry, client id, token endpoint. Tests inject an in-memory driver.

### URL guard

`assertConnectionUrl` in `shared/connection-url.ts`:

- https, or http only when the host is `127.0.0.1` (not localhost, not ::1)
- no userinfo, no credentials
- host is a DNS name or 127.0.0.1; reject private, link-local, metadata and
  IPv6 literals
- path and query allowed, hash dropped
- max 2048 chars

The same function guards OpenAPI spec URLs and every URL fetched during MCP
OAuth discovery (protected-resource metadata, authorization server metadata,
registration, token, authorize). The macOS app only opens a redirect the
server already validated, and only when the host equals the card's
`redirectHost` (https). That is the connect-card Composio-host rule, applied
to a host the server named rather than a hardcoded one.

### Seed: Excalidraw

`scripts/setup-local.mjs` (and a shared `seedDefaultConnections`) inserts this
row when missing, keyed by id `excalidraw` or by URL so a re-run is a no-op:

- id `excalidraw`
- kind `mcp`
- name `Excalidraw`
- url `https://mcp.excalidraw.com/mcp` (the hosted server 308s `/` to `/mcp`;
  Streamable HTTP speaks at `/mcp`)
- description for the model: official Excalidraw MCP App, call `read_me` then
  `create_view` to draw in the chat
- authKind `none`
- toolsAllow `["read_me", "create_view"]` (the other tools are app-only)

No Keychain item. After setup, every new eve session already has Excalidraw.

## eve wiring

`agent/connections/registry.ts` exports `defineDynamic` on `turn.started`
(not only `session.started`). A connection approved mid-session must exist on
the resume turn. Each map key is the registry id. `instanceKey` is that id.

| authKind | eve auth |
|---|---|
| none | omit `auth` and `headers` |
| bearer | `auth: { getToken }` from Keychain, `principalType: "app"` |
| apiKey | `headers: { [authHeader]: key }` from Keychain |
| oauth | `defineInteractiveAuthorization` with the generic MCP OAuth helpers; `getToken` reads Keychain and refreshes; missing or 401 throws `ConnectionAuthorizationRequiredError` |

`tools.allow` is set from `toolsAllow` when present. App-only MCP App tools
(`_meta.ui.visibility` is `["app"]`) are never put on the allow list.

The model discovers these through eve's built-in `connection_search` and
calls them as `{id}__{tool}` (e.g. `excalidraw__create_view`). We do not
write an MCP client for tool execution.

## Bot tool

`agent/tools/propose_connection.ts`, mirror of `propose_connector.ts`.

Input: `kind` (`mcp` | `openapi`), `url`, `name` (1..80), `description`
(3..400, for the model), `authKind`, optional `authHeader`, `purpose`
(3..120), optional `requestId`.

Guards:

- URL through `assertConnectionUrl`
- name and description trimmed; description is stored as data, never as an
  instruction
- one open `connectServer` card per bot (proposed or waiting), same as
  connectApp
- same URL already in the registry: `already_connected`
- unknown authKind: refused

Creates a `connectServer` proposal and a `proposal` agent event. Returns
`{ status: "awaiting_owner_confirmation", proposalId }`. The tool never
starts OAuth and never sees a secret.

## Proposal kind

```ts
export type ConnectServerProposal = {
  kind: "connectServer";
  connectionKind: ConnectionKind;
  connectionId: string;       // assigned at propose, stable
  name: string;
  urlHost: string;            // hostname only, for the card; never the full URL
  purpose: string;
  authKind: ConnectionAuthKind;
  authHeader: string | null;
  sourceBotId: string | null;
  threadId: string;
  phase: ConnectPhase;        // same four as connectApp
  redirectHost: string | null; // oauth authorize host, once waiting
  waitingSince: string | null;
  toolCount: number | null;
  handoffId: string | null;
};
```

The full server URL is stored on the registry entry at confirm, not on the
card after propose (the card shows the host). Propose keeps the URL in memory
on the proposal as `url` so confirm does not trust a second copy from the
client; that field is stripped from anything the model sees (the tool result
returns name and id, not the URL).

`status` keeps its existing meaning. `openProposals` includes waiting and
connected cards until the resume is queued.

## Confirm and pump

`shared/connection-flow.ts`, sibling of `connect-flow.ts`. Do not change the
Composio state machine.

`PUT /api/shell` grows a `connectServer` branch, desktop gate and CSRF
unchanged.

- **none:** write the registry row, probe `tools/list` (or OpenAPI operations),
  set `phase: "connected"` and `toolCount`, note "{name} connected", queue the
  resume. No browser.
- **apiKey / bearer:** the action carries `secret` once. Write Keychain, then
  the same as none. Empty or huge secrets are refused. The secret is never
  stored on the proposal, never logged, never returned.
- **oauth:** start the generic MCP OAuth flow, set `phase: "waiting"`,
  `redirectHost`, `waitingSince`, return `{ redirectUrl }` once. Reopen is
  the same call again.

`pumpConnections()` runs on every tick next to `pumpConnects`. For oauth
waiting cards it does not poll a third party: the callback route completes
the token exchange, writes Keychain, writes the registry row, and flips the
card connected. The pump's job is expiry (10 min), linger-retry of a
connected card whose resume could not be queued, and the same single-flight
and idempotent resume rules as connect-flow.

Resume message (instruction channel, id not display name):

`The owner connected the server {connectionId}. Continue the task: {purpose}`

Callback: `http://127.0.0.1:4320/api/connections/callback`. This one parses
`code` and `state` (unlike the Composio landing page). State and PKCE
verifier live in a 0600 pending file for the length of the flow, then go.
Tokens go to Keychain.

## MCP OAuth

Generic flow, no Vercel Connect:

1. GET the connection URL (or a 401) for protected-resource metadata
   (`/.well-known/oauth-protected-resource` or `WWW-Authenticate`)
2. Authorization server metadata
3. Dynamic client registration when advertised; PKCE S256 public client
4. Authorize URL with `code_challenge`, `state`, loopback redirect
5. Token exchange on the callback; refresh from `getToken` when `expiresAt`
   is near

Every fetched URL goes through `assertConnectionUrl`. A server that needs a
pre-registered client is refused with a structured error; the owner can
propose it again as `apiKey` or `bearer`.

`defineInteractiveAuthorization` wraps the same helpers so a later tool call
whose token was revoked can re-challenge. The card is the first-time UI. The
macOS app does not yet render eve's `authorization.required` event; a revoked
grant is a new card or a failed tool until that is built.

## macOS card

`Kind.connectServer` on `Proposal.swift`. Card title "Connect server". Body:
a server icon (SF Symbol `server.rack`, 28 pt), name in 15 semibold, purpose
in 13 muted, host in 12 faint.

- none, proposed: Connect and Not now
- apiKey / bearer, proposed: masked field ("Paste key"), Connect and Not now.
  Connect is disabled while the field is empty. The key never leaves the
  confirm request.
- oauth, proposed: Authorize and Not now
- waiting: ProgressView plus "Waiting for {name} sign-in", Reopen, Not now
- connected: green Connected pill, "{n} tools" when known, Not now. Leaves
  when the resume is queued, same as connectApp
- expired: "Sign-in timed out", Reopen and Not now

`decideProposal` opens the oauth URL only when scheme is https and the host
equals `redirectHost`. Reopen reuses confirm.

Web UI: `proposal-card.tsx` renders `connectServer` as unsupported with
Dismiss only. Not ported.

## Widget block

`TranscriptRow.Kind.widget`. `ChatView` draws a WKWebView of fixed width (the
chat column) and height 480, growing on `ui/notifications/size-changed` up to
720. Isolated `WKProcessPool`. Navigation allowed only to the loopback widget
URL. No file access.

Copy: no helper text under the drawing. The bot's reply sits below it.

## Instructions

Replace "Not in the catalogue: say so in one line and stop" with:

1. Catalogue first: `connector_catalog`. Found: `propose_connector` as today.
2. Not in the catalogue: look for the official MCP server, then an OpenAPI
   document. If you find one, `propose_connection` once, then end the turn
   with one line. Never propose two servers in one turn.
3. Neither exists: say so in one line and stop.
4. Already in the registry (Excalidraw is, after setup): use
   `connection_search`, then the connection tools. Do not propose it again.
5. When a turn says the owner connected the server, continue the original
   task.

## Security notes

- Secrets never in JSON, logs, tool results or the proposal store
- Confirm needs the desktop session and CSRF; the bot's tool cannot start
  OAuth or write Keychain
- URL guard on propose, confirm, OAuth discovery and widget resource fetch
- Widget HTML runs sandboxed; tool calls from the widget proxy only to the
  same registry connection, and only tools with `app` visibility
- Resume handoff is `depth: 0` and names the server by its validated id

## Testing

Node (`test/connections-store.test.ts`, `test/connection-url.test.ts`,
`test/connection-tools.test.ts`, `test/connection-flow.test.ts`,
`test/mcp-http.test.ts`, `test/mcp-apps.test.ts`):

- store: 0600, unknown keys kept out of the typed shape, corrupt file moved
  aside, seed is idempotent, secrets never in the JSON
- URL: https ok, http 127.0.0.1 ok, http localhost refused, private IPs
  refused, userinfo refused
- propose: creates the card, refuses a bad URL, a duplicate open card, an
  already-registered URL, honours requestId
- confirm none: registry row, tool count, resume once
- confirm apiKey: Keychain write, secret absent from the store
- oauth: waiting, redirect returned once, callback flips connected, 10 min
  expires, linger retry
- widget parser: `create_view` input becomes a widget record; app-only tools
  are not counted

Swift: `Proposal` decodes `connectServer` in every phase and authKind;
unknown phase falls back to proposed; widget rows decode; confirm action
carries `connectionId`.

Verification: `npm run build:app`, ditto into `/Applications`, relaunch,
screenshots `review-mcp-*.png` of proposed (Excalidraw Connect), connected,
and a drawing in the chat.
