# Connectors on Composio

Date: 2026-09-15. Status: approved by the owner the same day (all five decisions in section 6: yes) and built on `feat/connectors-composio`. Two changes from the plan as written: the enabled-toolkits toggle was dropped, because connected and enabled are the same thing for one owner, and the Composio session is created without a toolkit filter so the catalogue listing stays complete; the agent tools restrict themselves to the connected apps instead.

## 1. Where the repo stands

The Connectors entry exists in both shells and opens a placeholder:

- The removed web UI's marketplace dialog rendered "No connectors yet. MCP servers you add will show here."
- `macos/Sources/UsefulBotApp/RootView.swift` has the same `ConnectorsDialog` in SwiftUI.
- There is no `web/app/api/connectors` route, no store under `~/.useful-bot`, no agent tool and no `agent/connections/` folder.

So the frontend is a stub and the backend does not exist. The spec deferred integrations to v2 (`docs/spec/PLAN-FINAL.md`, "Deferred to v2"). This plan is that v2 work.

What the repo already gives us and the plan reuses:

- Authored eve tools in `agent/tools/*.ts` via `defineTool` from `eve/tools`. The filename is the tool name.
- A custom approval store (`agent/lib/approvals.ts`) with `request`, `waitUntilNotPending` and `executeIfApproved`. The `bash` tool gates through it and the UI renders the cards above the composer. `ApprovalTool` is a string union we can extend.
- Per-conversation permission modes `read_only | auto | full_access` in `shared/shell-store.ts`. Auto only stops for destructive actions.
- Guarded Next API routes (`requireDesktop`, CSRF header, rate limit) and 0600 JSON stores under `~/.useful-bot`, for example `providers.json`, which already holds API keys the owner pastes in the UI.
- eve 0.54.3 also ships MCP connections (`agent/connections/*.ts`, `defineMcpClientConnection`, `defineDynamic`). Considered below and not chosen for v1.

## 2. What Composio is (verified 2026-09-15)

Composio is a hosted auth and tool platform for agents. Numbers and API shapes below come from docs.composio.dev, composio.dev/pricing and the SDK reference.

- Catalogue: marketing says 1,500+ toolkits, the GitHub readme says 1,000+, one crawl in August counted 1,089 toolkits and 20,000+ tools. Order of magnitude is right, exact count moves.
- Vocabulary: a toolkit is one app (`gmail`), a tool is one action (`GMAIL_SEND_EMAIL`), an auth config says how a toolkit authenticates, a connected account is one user's stored credential, and the user id is our own stable string.
- Managed OAuth: for Gmail, Google Calendar, Drive, Slack, Notion, GitHub, Linear and most big apps Composio owns the OAuth app and refreshes tokens. No OAuth client registration on our side. Bring-your-own client is optional via a custom auth config.
- Sessions are the current core API (Tool Router went GA in 2026). TypeScript:

```ts
import { Composio } from "@composio/core";
const composio = new Composio({ apiKey });
const session = await composio.create("wasim", { toolkits: ["gmail", "github"], manageConnections: { enable: false } });
const link = await session.authorize("gmail", { callbackUrl });   // link.redirectUrl for the browser
await link.waitForConnection();
const found = await session.execute("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "read my unread mail" }] });
const result = await session.execute("GMAIL_FETCH_EMAILS", { max_results: 5 });
const again = await composio.use(session.sessionId);                // reuse across turns
```

- Account management: `composio.connectedAccounts.list({ userIds })` with `status`, `composio.connectedAccounts.delete(id)` revokes.
- MCP: `composio.create(userId, { mcp: true })` returns `session.mcp.url` and `session.mcp.headers` for any Streamable HTTP client. Same session backs `session.tools()`.
- Meta tools a session exposes: `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_WAIT_FOR_CONNECTIONS`, plus remote workbench and bash (we will not enable those).
- Triggers: inbound events (new mail, Slack message) delivered to a public webhook URL, signed. Not usable from a loopback-only app without a tunnel. Out of scope for v1.
- Package: `@composio/core`, ESM, Node 22.22+. Node 24.11.1 on this machine is fine.
- Pricing (signups on or after 2026-08-15): Hobby is free with 100,000 tool calls and 50,000 trigger events a month, unlimited connected accounts, usage pauses at the cap. Pro is $29 a month with $29 of credit, then $0.0003 per call. One person's agent stays inside Hobby.
- Security: AES-256-GCM at rest, TLS in transit, SOC 2 Type II, tokens redacted from API responses. Customer-managed keys only on Enterprise. No verified self-hosted option.
- 2026 changes to respect: v3 naming (toolkits, auth configs, connected accounts, user id, prefixed ids like `ca_`), v1/v2 endpoints return 410, `connectedAccounts.initiate()` retired for managed OAuth in favor of `link()` and `session.authorize()`.

## 3. Is Composio the right solution

Yes for the stated goal, with one tradeoff to accept knowingly.

The tradeoff: the original handoff said "Tokens never leave the Mac." With Composio the OAuth refresh tokens for Gmail, Slack and so on live in Composio's cloud, keyed to our user id. Every tool call goes Mac to Composio to the app. The Mac keeps only the Composio API key. That is the price of 1,500 apps without registering and maintaining an OAuth client per app. If that is unacceptable, the alternative is a per-app build (own OAuth apps, own token refresh, one integration at a time), which is weeks per handful of apps.

Alternatives checked and set aside:

- eve connections with Vercel Connect: the OAuth broker is a Vercel product and expects a Vercel-hosted app and an authenticated user principal on the eve session. The app is local-only with `localDev()` style sessions, so user-scoped connections fail with `principal_required`. Not a fit.
- Pipedream Connect and Nango: the same hosted-credential model as Composio with smaller catalogues or more self-assembly. No advantage here.
- Composio's own MCP endpoint through an eve MCP connection: the least code (one file in `agent/connections/`), but approvals would then run through eve's own human-in-the-loop pause, which this UI does not render. The repo's approval cards, Auto mode and audit hash all live in the custom store. Wrapping the SDK in two authored tools keeps that. We can revisit the MCP path once the eve pause is rendered.

## 4. Design

### 4.1 Pieces

| Piece | File | Job |
|---|---|---|
| Store | `shared/connectors-store.ts` | `~/.useful-bot/connectors.json` (mode 0600): `{ apiKey, userId, enabledToolkits: string[], sessionId: string \| null, updatedAt }`. Same read, parse and write shape as `providers.ts`. Locked writes like the routines store. |
| Client | `shared/composio.ts` | Builds the `Composio` client from the store, resolves the session (`use(sessionId)`, else `create(userId, { toolkits: enabledToolkits, manageConnections: { enable: false } })` and persists the id), lists toolkits with a one-hour in-memory cache, lists connected accounts, authorizes, deletes. Nothing else touches the SDK. |
| API | `web/app/api/connectors/route.ts` | `GET` status and catalogue, `PUT` set or clear key and toggle toolkits, `POST` authorize a toolkit and return the redirect URL, `DELETE` a connected account. Same `requireDesktop`, CSRF and rate limit as `routines/route.ts`. |
| Callback | `web/app/api/connectors/callback/route.ts` | Unauthenticated `GET` that Composio redirects to after OAuth. Renders one static line, "Connected. You can return to Useful Bot." It reads nothing from the query and writes nothing. |
| Search tool | `agent/tools/connector_search.ts` | Input `{ use_case }`. Calls `COMPOSIO_SEARCH_TOOLS` and returns tool slugs, one-line descriptions and trimmed input schemas through `toModelOutput`. Read-only, no card. |
| Execute tool | `agent/tools/connector_execute.ts` | Input `{ tool, arguments }`. Classifies risk from the slug, requests an approval card when needed, then `session.execute`. Result capped at a fixed byte size before it reaches the model, with the full payload discarded. |
| Risk | `agent/lib/connector-risk.ts` | Pure function slug to `read \| write \| destructive`. Read verbs: `GET`, `LIST`, `FETCH`, `SEARCH`, `FIND`, `READ`. Destructive: `DELETE`, `REMOVE`, `TRASH`, `ARCHIVE`, `REVOKE`, `CANCEL`. Everything else is write. Unknown shapes are write. |
| Approvals | `agent/lib/approvals.ts` | Add `"connector"` to `ApprovalTool`. Preview is `<toolkit> · <tool>` plus the arguments as compact JSON. |
| Instructions | `agent/instructions.md` | One paragraph: search before execute, never guess a slug, tell the owner to connect an app in Connectors when a call fails with `not_connected`. |
| Web UI | `web/components/marketplace-dialog.tsx` | Real dialog, see 4.3. |
| macOS UI | `RootView.swift` `ConnectorsDialog`, `AppModel.swift`, `BackendModels.swift` | Same states through `BackendClient`. Redirect opens with `NSWorkspace.shared.open`. |
| Cards | `web/app/page.tsx` approval card, `ChatView.swift` | Render the `connector` preview. Approve and Deny already exist. |

No change to `scripts/service.mjs`: the eve process and the web process both read `connectors.json` directly, the way they share the other stores.

### 4.2 Approval policy

Per conversation permission mode, matching what `bash` does today:

| Risk | read_only | auto | full_access |
|---|---|---|---|
| read | run | run | run |
| write | blocked, tool returns `read_only_mode` | card | run |
| destructive | blocked | card | run |

Full access runs destructive actions too (changed 2026-09-18): the owner chose the posture that asks nothing, and the wipe check in the shell is the only card left anywhere.

### 4.3 Connectors dialog

Three states, same in both shells:

1. No key. One field, "Composio API key", a Save button and a link to composio.dev where the key comes from. Last four characters shown after save, with Remove. Same pattern as Providers.
2. Key set. A search field over the toolkit catalogue and a list of rows: app icon from Composio's logo URL, name, status pill (Connected, Not connected, Pending) and a Connect or Disconnect button. Enabled toolkits float to the top.
3. Connecting. Connect calls `POST /api/connectors` and opens the redirect URL in the default browser. The row shows Pending and the dialog polls `GET /api/connectors` every three seconds for up to two minutes, then stops with "Still not connected. Try again."

Toggling a toolkit on or off rebuilds the Composio session with the new `toolkits` list, so the agent can only reach apps the owner enabled.

No helper copy under headings, per the UI rules.

### 4.4 One turn, end to end

1. Owner: "Any unread mail from Sanne this week?"
2. Model calls `connector_search({ use_case: "list unread emails from a sender" })`. The tool returns `GMAIL_FETCH_EMAILS` with its schema.
3. Model calls `connector_execute({ tool: "GMAIL_FETCH_EMAILS", arguments: {...} })`. Risk is read, so it runs. The tool truncates the result, the model answers.
4. Owner: "Reply that Thursday works." Model searches, gets `GMAIL_REPLY_TO_THREAD`, calls execute. Risk is write, mode is auto, so a card appears above the composer: "Gmail · GMAIL_REPLY_TO_THREAD" with the body. Approve runs it through `executeIfApproved`, with the action hash checked, exactly like a shell line.
5. If Gmail is not connected, execute returns `{ status: "blocked", error: "not_connected", toolkit: "gmail" }` and the instructions tell the model to say so and point at Connectors.

### 4.5 Security notes

- The API key is the only secret on disk, in a 0600 file, never in a repo file or a log. `last4` only in API responses, like providers.
- The model never sees the key, the session id or the redirect URL. Tools return data and error codes only.
- The callback route is loopback and stateless. Nothing on it can be abused by a crafted redirect.
- Rate limit on the connectors route, same helper as the others. Execute tool timeout 30 seconds.
- Result size cap before the model. Composio results can be large (a mailbox page). Cap and say "truncated" rather than flood the context.
- `manageConnections` disabled so the model cannot open OAuth flows by itself. Connections start from the dialog only.
- Composio's remote workbench and bash meta tools are never listed in the search results the tool passes on.

## 5. Phases

Every phase lands through the change management loop: branch, tests, review, PR, merge.

**Phase 0, spike (half a day).** Install `@composio/core` (needs a yes, it is an npm package). A throwaway script under `spikes/s4/` that, with the owner's Composio API key in the environment for that run only, creates a session for `wasim`, authorizes `gmail`, prints the redirect URL, waits for the connection, runs `COMPOSIO_SEARCH_TOOLS`, runs `GMAIL_FETCH_EMAILS`, then resumes the session by id. Pass or fail decides whether phases 1 to 4 start. It also confirms `manageConnections: { enable: false }` is a real option and how a `not connected` error is shaped.

**Phase 1, store, client and API.** `connectors-store.ts`, `composio.ts`, the two routes. Tests: store parse and write (mode 0600, bad input rejected), route guards (gate, CSRF, rate limit), client session resolution with a stubbed SDK. Add both test files to the `npm test` list.

**Phase 2, agent tools and approvals.** `connector-risk.ts`, the two tools, the `ApprovalTool` union, instructions. Tests: risk table, execute blocked in read_only, execute cards on write in auto, execute runs read without a card, result truncation, `not_connected` shape.

**Phase 3, UI.** Web dialog, macOS dialog, approval card rendering in both. Verified with screenshots of each state in both shells, then `npx tsc --noEmit`, `npm test` and `macos/test.sh`.

**Phase 4, live check and docs.** Connect Gmail and one write app (Linear or GitHub) for real, run the turn in 4.4, confirm the card, approve, confirm the effect in the app. Update README (Connectors section) and the v2 note in `PLAN-FINAL.md`.

Order of the adversarial review triggers in the global rules: phase 1 and phase 2 both touch secrets handling and privileged routes, so both get the review before their PR.

## 6. Decisions needed before phase 0

1. Accept that app tokens live in Composio's cloud (section 3).
2. Yes to installing `@composio/core`.
3. The default enabled toolkits. Proposal: none enabled until the owner connects one. The catalogue search covers the rest.
4. The approval table in 4.2, in particular whether full_access should skip the card on write actions (proposed: yes) and on destructive actions (proposed: no).
5. Triggers stay out until the app has an inbound path that is not loopback. Agree?

## 7. Out of scope

Triggers and webhooks, custom auth configs (own OAuth clients), Composio's remote workbench and bash, per-bot connector allowlists (all bots share the owner's connections in v1), multi-user.
