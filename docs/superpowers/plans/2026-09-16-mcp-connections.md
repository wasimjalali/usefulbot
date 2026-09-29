# MCP Connections Implementation Plan

**Goal:** Owner-approved MCP and OpenAPI connections for bots, Excalidraw first, with a Connect server card and the drawing rendered in the macOS chat.

**Spec:** `docs/superpowers/specs/2026-09-16-mcp-connections-design.md`

## Global Constraints

- Node interpreter is `/usr/local/bin/node`; tests run with `npm test`; typecheck with `npm run typecheck`; Swift tests with `npm run test:macos`.
- No em dashes anywhere. No helper copy under headings.
- Secrets in Keychain, never in JSON. URL guard on every fetch.
- Surgical edits; match existing style; `npm` only; work on branch `feat/mcp-connections`.
- Web UI is not ported: `proposal-card.tsx` shows `connectServer` as unsupported with Dismiss.
- Do not change the Composio `connectApp` state machine except to reuse helpers.

## File map

| File | Responsibility |
|---|---|
| `shared/connection-url.ts` | `assertConnectionUrl` |
| `shared/keychain.ts` | Keychain driver, in-memory for tests |
| `shared/connections-store.ts` | Registry JSON, seed Excalidraw |
| `shared/mcp-http.ts` | Streamable HTTP JSON-RPC: initialize, tools/list, resources/read |
| `shared/mcp-oauth.ts` | Discovery, DCR, PKCE, token exchange |
| `shared/mcp-apps.ts` | Parse stream events into widget records |
| `shared/widgets-store.ts` | Widget payload files, 0600 |
| `shared/connection-flow.ts` | Confirm, callback, pump, resume |
| `shared/agent-store.ts` | `connectServer` proposal, `widget` event |
| `agent/connections/registry.ts` | `defineDynamic` on `turn.started` |
| `agent/tools/propose_connection.ts` | Bot raises the card |
| `agent/instructions.md` | Catalogue, then MCP, then OpenAPI |
| `scripts/setup-local.mjs` | Seed the registry |
| `web/app/api/shell/route.ts` | `connectServer` confirm |
| `web/app/api/agent/tick/route.ts` | `pumpConnections` |
| `web/app/api/connections/callback/route.ts` | OAuth callback |
| `web/app/api/connections/widget/[id]/route.ts` | Host page |
| `web/app/api/agent/widget/route.ts` | Persist a widget event |
| `web/components/proposal-card.tsx` | Unsupported fallback |
| macOS Proposal, ShellActions, AppModel, ProposalCardView, ChatView, EveStream, Transcript | Card, URL guard, WKWebView |

## Tasks

1. URL guard + Keychain driver + connections store + Excalidraw seed (tests first)
2. `connectServer` proposal kind and `widget` event in the agent store
3. MCP HTTP helper and OAuth helpers (stubbed fetch)
4. `connection-flow` confirm / callback / pump
5. `propose_connection` tool
6. eve `defineDynamic` registry
7. Web routes (shell, tick, callback, widget host)
8. Instructions, README, setup-local
9. macOS decode, card, confirm, URL open, widget WKWebView
10. Wire tests into `package.json`, typecheck, Swift tests

Each Node area gets a test file in `test/` registered on the `test` script.
