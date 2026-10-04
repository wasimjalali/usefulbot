# UB-009 step 0: eve spikes (read-only research)

Date: 2026-10-01. Branch `feat/ub009-agent-context`. Method: read of `node_modules/eve` (version **0.54.3**,
`node_modules/eve/package.json`), its docs and this repo's code. Nothing was run, built or started, so every
runtime behavior below is "verified in source", not "observed". Where I infer, I say "unverified".

eve's `dist/src/**/*.js` is minified to one line per file, so dist evidence is cited as `file (function)`.
Doc evidence is `docs file:line`. Repo evidence is `file:line`.

| # | Spike | Verdict |
|---|---|---|
| 1 | JWT bot claim | **Works**, with four caveats (one changes the plan: a throwing instruction resolver does not fail a turn) |
| 2 | eve memory slot | **Works with caveat**. Recommended over the system-block fallback. Two plan assumptions are wrong (empty record, retract) |
| 3 | OpenAPI approval hook | **Works with caveat**. Policy must never throw, and a minutes-long wait inside it has a different timing envelope than today's MCP wait |
| 4 | Disable `agent` and `task_cancel` | **Works** with `disableTool()` for both. One leftover: the `reviewer` subagent keeps the "Agent messaging" prompt block alive |

---

## 1. JWT bot claim

### Verdict: works

A `botId` string claim in the per-request channel JWT reaches `ctx.session.auth.current.attributes.botId`
on the very first turn of a new session, with no polling and no race.

### Evidence

Claim to attributes:
- `jwtHmac` verifies, then `createJwtAuthenticatedCallerPrincipal` projects every string or string-array claim
  except `aud exp iat iss jti nbf sub` into `attributes` (`dist/src/channel/auth/token-claims.js`
  `createJwtAttributeProjection`, `STANDARD_PROJECTED_CLAIM_KEYS`; `jwt-hmac.js` `authenticateJwtHmacStrategy`).
  `createRuntimeSessionAuthContext` keeps `attributes, authenticator, issuer, principalId, principalType, subject`
  (`channel/auth/types.js`). Non-string claims (numbers, objects) are dropped, so `botId` must be a string.
- `exp` and `iat` are not in the auth context, so two tokens for the same bot compare equal under
  `jsonValuesEqual(c.auth, t.auth)` and queued follow-ups still batch (`execution/parked-delivery-wait.js`).
- `principalId` is `"<iss>:<sub>"`, here `useful-bot:desktop-app`.

Create path:
- `POST /eve/v1/session` runs `routeAuth(request, auth)` and passes that auth into the session run
  (`eve-channel/index.js`, the `POST(EVE_SESSION_ROUTE_PATH…)` handler). `buildRunContext` does
  `r.set(AuthKey, run.auth)` and `r.set(InitiatorAuthKey, run.initiatorAuth ?? auth)`
  (`execution/runtime-context.js`).
- `buildResolveContext` hands every dynamic resolver `session.auth = { current: AuthKey, initiator: InitiatorAuthKey }`
  (`context/dynamic-resolve-context.js`). So a `turn.started` instruction resolver, a memory `scope`, and the
  `step.started` model resolver all see the claim on turn 1.
- Doc precedent for exactly this pattern: `docs/tutorial/team-playbooks.mdx:55-80` ("the team comes from
  authenticated claims, not from the message").

Per request, not per session:
- Every follow-up replaces `auth.current`: `n.input?.kind==='deliver' && n.input.auth!==void 0 && ctx.set(AuthKey, n.input.auth ?? null)`
  (`execution/workflow-steps.js`). Doc: `docs/guides/auth-and-route-protection.md:258` (`auth.initiator` stays pinned
  to the session creator, `auth.current` tracks the latest caller).
- Deliveries with different `auth` are not merged into one turn (`parked-delivery-wait.js`: `!jsonValuesEqual(c.auth,t.auth)` breaks the batch;
  `harness/messages.js coalesceDeliveries` takes the last defined auth).
- Doc `auth-and-route-protection.md:263`: "Route auth does not enforce session ownership." Eve checks nothing about
  which bot a session belongs to.

Turns eve starts itself (no HTTP request):
- Background task wake-ups are sent as `{ kind:'send', payload, taskDeliveryId }` with **no `auth`**
  (`execution/tasks/child/steps.js wakeTaskParentStep`). `auth === undefined`, so the `AuthKey` branch above is
  skipped and the turn keeps the last request's auth.
- `AuthKey` is a plain context key with no codec, and `serializeContext` writes every key
  (`context/serialize.js`), so the last auth survives parking and process restarts.
- Authorization-callback resumes are `deliver` inputs with no `auth` either (same branch), so the claim is kept.
- Child sessions (`agent`, declared subagents) are started with `auth: parent auth` and `initiatorAuth`
  (`subagents/tool.js buildSubagentRunInput`), so the claim propagates. The child's session id is **not** in any
  session-to-bot table, so a lookup by session id fails for children while the claim still works.
- No schedules are authored in this repo (`agent/` has none), and eve gives schedule turns the `eve:app` runtime
  principal, which would carry no claim (`docs/guides/session-context.md`).

Sessions that predate the change: their persisted `AuthKey` has no `botId` until their next request carries one.
Self-started turns on them see `attributes.botId === undefined`. The resolver needs the binding-store fallback.

### Today's code (what has to change)

- Token has no bot claim and one shared cache: `web/lib/agent-exec.ts:225-237` (`signChannelJwt(secret, "desktop-app")`),
  `:249-267` (`channelJwt()`, single cached token, falls back to the baked `UB_CHANNEL_JWT`).
- Same signer in `scripts/service.mjs:108`; the env token baked at `:241-245` carries no claim either.
- Proxy mints with no bot: `web/app/eve/v1/[...path]/route.ts:107`. `runEveTurn` at `web/lib/agent-exec.ts:654`
  (reused at `:696, :722, :761, :776`).
- Eve-side auth verifies the token but compares only the principal: `agent/channels/eve.ts:21-48`;
  ownership is `agent/lib/session-owners.ts:18-25` (`INSERT OR IGNORE` keyed by session, value = principal).

### Hijack analysis (who mints, what is checked)

- Only holders of `UB_CHANNEL_JWT_SECRET` can mint: the web service (`service.mjs:245`), the eve process
  (`service.mjs:215`), the Keychain item `channel.desktop`. The bash tool env is scrubbed of it
  (`agent/tools/bash.ts:192-210`), so the model cannot mint through a normal `bash` call. An owner-approved
  `bash` running `security find-generic-password` could read the Keychain (PR A section 5.1 keeps credential stores
  reachable under approved lines). Out of scope here, but it is the one path to minting.
- Today nothing ties a session to a bot. The proxy trusts the **client-supplied** `botId` in the body
  (`route.ts:132-133, :169-172, :201-202`) for routing and identity prefix, for any session id in the path. And
  `SessionOwners.claim` binds every session to the single principal `desktop-app`, so it separates nothing.
- `channelAuth` does not claim on **create**: `sessionIdFrom()` returns null for `POST /eve/v1/session`
  (`agent/channels/eve.ts:14-21`), so a created session is unclaimed until its first follow-up or stream read.
  First claim wins, so the first caller after create would set the owner.
- Claim is not checked against the durable owner anywhere yet. It has to be, and the check has to happen **before
  eve accepts the turn** (a turn eve accepts and then fails retires the session).

### Sketch

```ts
// web/lib/agent-exec.ts
function signChannelJwt(secret: string, sub: string, botId: string): string {
  // payload gains: botId (string). sub stays "desktop-app" so existing owner rows stay valid.
}
const tokens = new Map<string, { token: string; exp: number }>();
export function channelJwt(botId: string): string {
  const secret = process.env.UB_CHANNEL_JWT_SECRET;
  if (!secret) throw new Error("channel_credential_missing"); // the baked UB_CHANNEL_JWT has no claim: drop the fallback
  /* per-bot cache, same re-sign-within-1h rule; HS256 signing is microseconds, so no cache is also fine */
}
// proxy: botId for a continuation comes from the durable session->bot store keyed by the PATH session id,
// never from the body; a body botId that differs is a 400. For a create, botId = validated roster bot.
// GET stream/cancel use the same bound bot.
```

```ts
// agent/channels/eve.ts  (inside the returned AuthFn, after verify)
const botId = ctx.attributes.botId;
const sessionId = sessionIdFrom(request);
if (sessionId) {
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new ForbiddenError({ message: "bot_claim_missing" });
  if (owners.claim(sessionId, principalKey(ctx), botId) === "forbidden") throw new ForbiddenError({ message: "session_ownership" });
}
// SessionOwners: add bot_id column; INSERT OR IGNORE (session, principal, bot); forbidden if the stored bot_id is
// non-null and differs; legacy rows (NULL) adopt the first claim only after the proxy backfilled from the shell.
```

```ts
// agent/instructions/context.ts (and agent.ts step.started, memory scope)
function claimedBotId(ctx: { session: { auth: { current: { attributes: Readonly<Record<string, string | readonly string[]>> } | null } } }): string | null {
  const v = ctx.session.auth.current?.attributes.botId;
  return typeof v === "string" && v.length > 0 ? v : null;
}
// precedence: claim, then the durable binding store (legacy sessions, self-started turns on old sessions).
// If both exist and differ: refuse (see risk 1).
```

The same claim replaces the poll in `agent/lib/model-window.ts:97-108` (`awaitTurnStamp`) and the roster lookup in
`sessionOwner()` (`:26`) for the first step. The freeze still reads the bot's current selection from the shell, but it
looks the bot up by the claim, so the 10 s stamp wait goes away.

### Risks and plan-impacting findings

1. **A throwing instruction resolver does not fail the turn.** `dispatchDynamicInstructionEvent` runs resolvers in
   `Promise.allSettled`, logs `Dynamic instructions resolver (turn.started) threw — skipping.` and carries on
   (`context/dynamic-instruction-lifecycle.js`). Plan section 2 says "inside eve, dispatch refuses a non-child turn
   whose snapshot is missing". That cannot live in the instruction resolver: a throw there silently drops the
   whole context block and the model runs with no bot context. Places that do fail a turn: the `step.started`
   model resolver (`docs/guides/dynamic-capabilities.md:19-23`: "a missing, invalid, or throwing selection fails
   the turn"; `agent/agent.ts:185` already throws `turn_stamp_missing`), a throwing memory `scope` or `recall`
   (spike 2), and the channel `AuthFn` (403 before accept, best). Put the backstop in the model resolver, keep the
   channel check as the primary gate.
2. Create is not claimed by `channelAuth`, so the first binding must be written from the verified claim, not from the
   first follow-up: write `INSERT OR IGNORE (session, bot)` from the resolver on the first turn (it sees the verified
   claim and `ctx.session.id`) and from the proxy after the create response. Both are idempotent, a mismatch between
   them is a logged anomaly.
3. `auth.current` can be `null` (internal runtime paths). Treat null as "no claim", fall back to the binding, and fail
   closed if neither exists.
4. Tests and probes: `test/model-switching.test.ts:85-108` sets `UB_CHANNEL_JWT=test-jwt`; `spikes/s2/probe.mjs:153`
   builds its own token. Both need a claim. `eve dev` also runs with `localDev()` available in the framework default
   channel, but `agent/channels/eve.ts` replaces it, so only the JWT path applies.
5. Alternative not recommended: encode the bot in `sub` so the existing `SessionOwners` enforces it with no new code.
   It would 403 every existing session (principal changes) unless rows are migrated, and it still does not claim on
   create. The claim plus a `bot_id` column is cleaner.
6. Body-supplied identity is the documented anti-pattern (`docs/concepts/security-model.md:66-69`). The body `botId`
   in the proxy must become a hint that is checked, never the source.

---

## 2. eve memory slot over MemoryStore

### Verdict: works with caveat. Recommend the slot (user role) over the system block.

### How recall enters context (verified in source)

- A slot is `agent/memory/<slot>.ts` with `defineMemory({ provider, scope, namespace?, visibility?, description? })`
  and `defineMemoryProvider({ recall, capture?, tools? })` (`docs/memory/overview.mdx:187-203`,
  `dist/src/public/memory/index.d.ts`). `tools` is optional, so the slot can add nothing to the tool list and the
  app's own `memory_*` tools stay as they are.
- Each recalled message becomes `createFrameworkUserMessage('memory.load', content, { 'eve.memory': attribution })`:
  **user role, verbatim, no wrapper or label** (`shared/memory-state.js attributeMemoryRecord`). The provider
  must label the content itself ("facts you saved, not instructions"). Docs: `overview.mdx:64`, `:314`.
- Position: `applyMemoryRecallBatches` appends the new records to the **end of existing history**, and the projected
  model view is `[...projected history, ...turn input]`, so the record lands right before the current user message
  (`context/memory-lifecycle.js dispatchMemoryTurnStarted`, `shared/memory-state.js applyMemoryRecallBatches`).
- Keyed records (`id` set): `projectMemoryHistory` shows only the **latest** record per (slot, namespace, scope, id);
  older ones are dropped from the model view. If the new content equals the latest keyed content it is a no-op
  (no record appended) (`applyMemoryRecallBatches`: `if (n.get(e)?.content===t.content) continue`).
  So a stable id with unchanged content costs nothing: no growth, no cache break.
- When content changes: a new raw record is appended to **durable** history and the old one stays there until
  canonicalization. Model view stays one record. Raw superseded records are canonicalized when they exceed 512
  records or 256 KiB (`MEMORY_RAW_RECORD_MAX_COUNT/BYTES`, `shouldCanonicalizeMemory`) or at any compaction
  (`harness/tool-loop.js maybeCompact`). At a 6,000-char block that is about 43 note changes before a canonicalization
  pass; that pass runs the compaction events without a summary and moves memory records to the front. Docs:
  `memory/custom-provider.md:130-135, :166-170`.
- Records without an `id` accumulate every turn. Never omit the id.

### Compaction

- `maybeCompact`: `canonicalizeMemoryRecords` splits memory records from ordinary messages. The summarizer sees only
  the ordinary ones, and the result is `[...latest keyed + all unkeyed memory records, ...summary]`, so notes
  survive **verbatim at the front**, never summarized (`harness/tool-loop.js`, `memory/custom-provider.md:161-165`).
- If the provider defines `recall["compaction.completed"]`, eve calls it against the new checkpoint and applies the
  result the same way (superseding if changed). If it does not, the canonical record simply stays. Either way the
  notes are present after a checkpoint. Defining the handler gives a fresh read after compaction. `clear()` removes
  the records and locks but not the store; the next turn recalls again (`overview.mdx:331-336`).

### `scope(ctx)`

- Input: `{ abortSignal, session: { id, auth: { current, initiator } }, channel: { kind, continuationToken, metadata } }`.
  No messages, no turn (`MemoryScopeContext` in `public/memory/index.d.ts`).
- Sync or async: `typeof scope==='function' ? await scope(ctx) : scope` (`memory-lifecycle.js resolveMemoryLock`).
  So it can read `attributes.botId`, or poll the binding store with a bound.
- Return `string | string[] | null`. Each component must be a non-blank string up to 1,024 bytes, tuple up to 16
  (`createMemoryLock`, `validateMemoryScopeValue`).
- **null** disables the slot for that operation: provider and tools are skipped, and `projectMemoryHistory` hides
  every earlier record of that slot (the lock is missing, so `a===void 0 -> []`). That is a safe fail-closed shape
  for an unbound session: notes vanish, they never leak to another bot. (`overview.mdx:251-254`)
- **throw**: nothing catches it. `Promise.all` over the slot locks rejects inside `dispatchMemoryTurnStarted`, and
  the turn fails before the model call. Wrap it, return null.
- The resolved value is available to the provider as `ctx.memory.scope.value`; `scope.key` is an opaque digest and
  is not needed because the store partitions by bot id itself.

### Recall result rules that break two plan assumptions

- **Blank content throws**: `validateMemoryRecallResult` rejects `content.trim().length===0`
  ("content must be non-blank"). So "one aggregate record replaced on every recall (including an empty one)" cannot
  send an empty string. Send a sentinel ("You have no saved notes.") under the same id.
- **Recall cannot retract.** Returning `null` or `{messages: []}` leaves the previous record in place
  (`custom-provider.md:133-135`). After the owner deletes the last note, the old block would still show until a
  sentinel supersedes it. The sentinel is therefore required, not cosmetic. Same for "recall returns nothing on a
  store error": that keeps the previous record (stale, not leaking). Acceptable, but say so.
- **Throwing recall fails the turn** (`custom-provider.md:175-178`), so the plan's "recall never throws" rule is
  load-bearing. A try/catch returning `null` is right.
- **Replay must be deterministic.** `applyMemoryRecallBatches` stores a digest per `operationId` and throws
  `Memory recall operation "…" replayed with a different result` if a replayed handler returns different content.
  `operationId` is `eve-memory-operation-v1:<session>:<seq>:<turn>:<phase>:<slot>`, stable across workflow replay.
  If the owner edits a note in Settings between the first run and a replay of the same turn start, the turn fails.
  Cache the rendered block per `operationId` in a small in-process map (bounded, a few hundred entries).
- Render deterministically: no relative times ("2 minutes ago"), sorted by `updatedAt` desc then id. Any byte change
  every turn defeats the no-op and the cache.

### Token cost per turn

- Roughly the block's size on every model call of every turn: up to the 6,000-char cap, about 1,500 tokens by the
  usual 4 chars/token estimate (an estimate, not measured). Cached after the first call while unchanged.
- A change costs one re-ingest of everything after the old record's position (the old one is removed from the view,
  the new one is appended near the end), so a note change late in a long chat re-ingests most of the conversation
  at uncached price, once. The system-block fallback has the same cost when notes change, and a larger one if the
  system block also carries anything per-turn, because system content precedes all history.
- Unchanged notes: zero extra growth in the model view in both designs.

### Slot versus fenced system block

| | Slot (user role) | Fenced block in the system-role context message |
|---|---|---|
| Authority | User role. A note written after outside content cannot pass as a system rule | System role. Only the fence protects; a broken fence is a system-level injection |
| Compaction | Framework keeps it verbatim at the front and can re-recall | Always present (outside history); needs no handling |
| History growth | One model-visible record; raw copies pruned at 512 records or 256 KiB or at compaction | None |
| Cache on change | Re-ingest after the record | Re-ingest the whole prompt (system precedes history) |
| First-turn race | `scope` reads the claim, or null hides it | Same resolver wait |
| Failure surface | Scope or recall throw fails the turn (must guard); replay digest rule; no retract; non-blank | A resolver throw is swallowed and the block is silently missing |
| Complexity | New slot file plus provider, about 60 lines | One more section in `context.ts` |
| Model-template risk | Two consecutive user messages (record, then the owner message). Some local chat templates dislike it. Unverified | None |

**Recommendation: the slot.** Reasons: the trust level matches "remembered facts, never instructions" with no reliance
on a fence; the framework owns compaction and keeps the record out of the summary; the no-op rule gives zero cost
when notes are stable. Keep the fallback for one case: if the payload probe or the 8B local-model eval shows a
template rejecting adjacent user messages, switch to the fenced block. The plan's own wording (section 4) already
allows that.

### Sketch

```ts
// agent/memory/notes.ts   (slot name "notes", no tools)
import { defineMemory, defineMemoryProvider } from "eve/memory";
import { boundBotId } from "../lib/bot-binding.ts";      // claim first, then the durable store, bounded wait
import { renderNotesBlock } from "../lib/notes-block.ts"; // <= 6,000 chars, deterministic, sentinel when empty

const RECORD_ID = "bot-notes";
const byOperation = new Map<string, string>();            // replay determinism, bounded

async function recall(ctx: { operationId: string; memory: { scope: { value: string | readonly string[] } } }) {
  try {
    const botId = String(ctx.memory.scope.value);
    let content = byOperation.get(ctx.operationId);
    if (content === undefined) {
      content = renderNotesBlock(sharedMemoryStore(), botId);   // never blank
      if (byOperation.size > 256) byOperation.delete(byOperation.keys().next().value!);
      byOperation.set(ctx.operationId, content);
    }
    return { messages: [{ id: RECORD_ID, content }] };
  } catch (err) {
    console.error("[memory] notes recall failed", err);
    return null;                                              // keeps the previous record; never fails the turn
  }
}

export default defineMemory({
  provider: defineMemoryProvider({ recall: { "turn.started": recall, "compaction.completed": recall } }),
  scope: async (ctx) => {
    try { return await boundBotId(ctx); } catch { return null; }   // null: slot off, notes hidden
  },
});
```

`sharedMemoryStore()` is lazy (`agent/lib/memory.ts:503`), so importing it at module scope is safe for eve's
build-time evaluation of authored modules (`docs/guides/dynamic-capabilities.md:9`).

### Unverified

- That no stream event carries the `memory.load` record to the app's transcript. The protocol event set has no
  memory event (`dist/src/protocol`), and recall results are only merged into history, so it should not appear, but the
  payload probe and a transcript screenshot should confirm.
- Token cost figure above (estimate).
- Local chat-template behavior with two consecutive user messages.

---

## 3. OpenAPI approval hook

### Verdict: works with caveat

### What the policy receives and may return

- `defineOpenAPIConnection` accepts `approval` (`internal/authored-definition/connection.js`: `KNOWN_OPENAPI_TOP_LEVEL_KEYS`
  includes `approval`; `normalizeApproval` accepts a function or `{ request, response? }`).
- It is the shared `ApprovalPolicy`: `(ctx: ApprovalContext) => ApprovalStatus | Promise<ApprovalStatus>`
  (`dist/src/approval/definition.d.ts`). `ctx` = session context (`session.id`, `session.auth.{current,initiator}`,
  `session.turn`, `session.parent`) plus `approvedTools`, `callId`, `toolInput` (the model-authored input only,
  never provided arguments), `toolName`. Doc: `docs/tools/human-in-the-loop.md:43`.
- Returns: `"user-approval" | "not-applicable" | "approved" | "denied"`, booleans, or `{ type: "approved"|"denied", reason? }`
  (`human-in-the-loop.md:43-57`). `approval-definition.d.ts ApprovalStatus`.
- It is `async`-capable and **awaited** with no eve timeout: `harness/tools.js buildApprovalFn` does
  `await resolveApprovalPolicy(approval)({...buildCallbackContext(), approvedTools, callId, toolInput, toolName})`,
  and `node_modules/ai/src/generate-text/resolve-tool-approval.ts:55-81` awaits it. The AI SDK `timeout` option applies
  to `executeToolCall` only (`execute-tools-from-stream.ts`), not to the approval call.
- Tool name: connection tools are keyed `<connection>__<operation>`
  (`execution/tools/connection-search.js qualifiedConnectionToolName`). The policy for a discovered tool is
  `requestDiscoveredConnectionToolApproval`, which calls `resolveApprovalPolicy(getConnectionApproval(connection))(ctx)`.
  I expect `ctx.toolName` to be the qualified name (inferred from the tool key; **unverified**). Connection ids match
  `^[a-z][a-z0-9-]{0,63}$` (`shared/connections-store.ts:46`), so the first `__` splits it unambiguously.
- Dynamic connections rebuild their approval callbacks when a parked turn or retried step resumes, without
  serializing them (`docs/guides/dynamic-capabilities.md:213-217`). So the closure can capture `entry` freely.
  `agent/connections/registry.ts` already is a `defineDynamic` at `turn.started`.

### Can it await the app's own card?

Yes, mechanically. `sessionPermission(ctx)` needs only `{session:{id}}` (`agent/lib/permission.ts:10`) and
`approvalActor(ctx)` needs `session.id`, `session.turn.id`, `callId` (`agent/lib/approvals.ts:109-119`); the policy
context has all of them. `waitUntilNotPending` (`approvals.ts:398`) can be awaited in the policy.

Caveats:
1. **Timing envelope differs from today's MCP wait.** The MCP card wait sits in the tool's `execute`
   (`agent/tools/connection_tools.ts:178-221`), which runs after the model call ended. The approval policy runs
   inside the model-stream transform, per tool-call chunk, while the stream is still open
   (`node_modules/ai/src/generate-text/execute-tools-from-stream.ts:~120-125`: `await resolveToolApproval` in the
   chunk handler). Mitigating: after the tool-call chunk only a small tail (finish, usage, `[DONE]`) remains, which
   should fit in socket buffers, so the router likely finishes before the owner answers. Not guaranteed: the router
   has `REQUEST_TOTAL_MS = 180_000` and idle timers (`router/src/index.ts:53-55, :640, :747-767`), and a stalled
   client under backpressure (`waitForDrain(res, signal)`) can hit the total timer. The card TTL is 5 minutes
   (`shared/policy.ts:18`). **Unverified**: needs one live run with a 4+ minute wait. Until then, cap the wait in the
   policy path at about 150 s and return denied `approval_timed_out` (the model then tells the owner).
2. **A throw is a failed turn.** `buildApprovalFn` has no catch, the SDK transform has none, so
   `approval_expired`, `approval_not_found`, a locked store or any bug in the policy fails the step and the
   turn, and a failed turn retires the session. The policy must wrap everything and return
   `{ type: "denied", reason }`.
3. **Parallel calls queue.** Two OpenAPI calls in one step are approved one after the other (chunk handler is
   sequential), unlike MCP's parallel `execute`. Card 2 appears after card 1 resolves.
4. **No abort signal in the policy context.** A cancelled turn cannot interrupt the wait, but `retireCards` on
   `/cancel` (`route.ts:retireCards`, `ApprovalStore.expireSession`) expires the session's cards, which ends
   `waitUntilNotPending`. Good enough, verify in the replay test.
5. **No re-check between approval and the HTTP call.** Eve executes the call right after the stream ends from its
   own registry snapshot. A repointed connection (`entry.url` changed) is not seen by eve. The policy can re-read the
   connection row after the wait and deny on a changed url, narrowed `toolsAllow`, or changed permission, the same
   three checks the MCP path does (`connection_tools.ts:178-221`). The window after the policy returns is the
   remaining stream tail, milliseconds.
6. **Replays raise a fresh card.** A step retry re-runs the policy. The old card stays pending until TTL. That
   fails safe. `executeIfApproved` consumes the record on first use, so a replayed approval id is refused.
7. `ctx.toolInput` can be `undefined`; guard it (`human-in-the-loop.md:43`).

### Denied is a clean refusal

- `{ type: "denied", reason }` makes the SDK emit an automatic `tool-approval-request` (`isAutomatic: true`) plus
  `tool-approval-response approved:false reason` and **not execute** (`execute-tools-from-stream.ts` `case 'denied'`).
  eve ignores automatic requests when building input requests, so the turn does not park and no eve card appears
  (`harness/input-extraction.js extractApprovalRequests`: `a.isAutomatic===!0 -> continue`).
- The model receives a tool result `execution-denied` with the reason. For the OpenAI-compatible provider the tool
  message content is exactly `output.reason ?? 'Tool call execution denied.'`
  (`node_modules/@ai-sdk/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts:264-266`).
  eve's own action record is `{ code: "TOOL_EXECUTION_DENIED", message: reason }` (`harness/action-result-helpers.js`).
  So a plain sentence in `reason` (for example "Read only mode: ask the owner to switch to Auto.") is what the model reads.

### `operations.allow`

- Normalized by `normalizeFilterField` (exactly one of `allow` / `block`, string arrays) (`connection.js`).
- Applied when operations are loaded: `operations.filter(op => passesToolFilter(op.toolName, filter))`
  (`runtime/connections/openapi-client.js`, `passesToolFilter` in `mcp-client.js`: `allow.includes(name)`).
  Enforced at execution too: `executeTool` looks the name up in the filtered map and throws `Tool "…" not found`
  otherwise. So a name outside the list is neither discoverable nor callable. Matching is by derived `toolName`
  (`operationId`, or the `<method>_<path>` derivation, with `uniqueName` de-duplication: `docs/connections/openapi.mdx:110`).
- Today `agent/connections/registry.ts:definitionFor` passes `tools: { allow }` only on MCP entries and never
  `operations` on OpenAPI entries, so `toolsAllow` is ignored for OpenAPI. That is the gap plan section 5.2 closes.
  The stored allow-list must hold derived names, and a name that no longer exists after a spec update should be shown
  in Settings as stale.

### Sketch

```ts
// agent/connections/registry.ts (OpenAPI branches)
function openApiApproval(entry: ConnectionEntry): ApprovalPolicy {
  return async (ctx) => {
    try {
      const permission = sessionPermission(ctx);
      if (permission === "read_only") return { type: "denied", reason: "Read only: this changes things in another app. Ask the owner to switch to Auto or Full access." };
      const operation = ctx.toolName.slice(entry.id.length + 2);           // "<id>__<operation>"
      const args = ctx.toolInput && typeof ctx.toolInput === "object" ? ctx.toolInput : {};
      const argsText = JSON.stringify(args, null, 1);
      if (permission === "auto" && argsText.length > CARD_ARGS_MAX) return { type: "denied", reason: "Arguments too long to show on a card." };
      const hash = actionSha256({ tool: "connection", canonicalArgs: JSON.stringify({ connection: entry.id, tool: operation, arguments: args }), cwd: "", targetRevision: null, backend: "openapi", toolVersion: "1" });
      const approvals = getApprovalStore();
      const rec = approvals.request({ ...approvalActor(ctx), tool: "connection", actionSha256: hash, preview: `${entry.id} · ${operation}\n${argsText}` });
      if (permission === "full_access") approvals.decide(rec.id, "approve", hash);
      else await waitUntilNotPending(approvals, rec.id, 150_000);          // see caveat 1
      if (sessionPermission(ctx) !== permission) return { type: "denied", reason: "Permission changed while the card was open." };
      const live = findConnectionById(entry.id);
      if (!live || live.url !== entry.url) return { type: "denied", reason: "The connection changed. Try again." };
      return await executeIfApproved(approvals, rec.id, hash, () => ({ type: "approved" as const }));  // throws on denied/expired/replayed
    } catch (err) {
      return { type: "denied", reason: err instanceof Error && /approval_expired|denied/.test(err.message) ? "The owner did not approve it." : "Could not get approval." };
    }
  };
}
// definitionFor(): add  approval: openApiApproval(entry)  and  operations: { allow: entry.toolsAllow }  (only when set)
```

If caveat 1 fails the live run, the fallback is the one the plan already names: Auto refuses with "needs Full access".
A third option that avoids the stream timing entirely: return `"user-approval"` and let eve park the turn durably, but
the macOS app does not render eve's `input.requested` today (project memory: "input.requested gap"), so it needs UI work.

---

## 4. Disabling `agent` and `task_cancel`

### Verdict: works. Use `disableTool()` for both.

Version: eve **0.54.3** (`node_modules/eve/package.json`).

Why project memory's refusal does not apply: eve throws
`Source "<path>" disables a slot with no lower-precedence source`
(`compiler/source-graph.js disableComposedCandidate`) when a `disableTool()` file has nothing underneath it in the same
slot. That was `agent/tools/plant_read.ts` (repo-owned, no default behind it; see `agent/tools/plant_read.ts:5-12`
and `docs/audit/SCOREBOARD.md:426`). `agent` and `task_cancel` do have a framework default behind them:
- `tools/agent.ts` is in `rootDefaults`, `tools/task_cancel.ts` is in `localDefaults` (`all-local-nodes`)
  (`framework/sources/registry.js`). So an app-layer `disableTool()` at those slots shadows a real candidate and composes.
- `assertFrameworkToolPolicy` only blocks disabling `tools/connection_search` and overriding (not disabling)
  `agent`/`task_cancel` (`compiler/default-tool-policy.js`).
- Documented: `docs/subagents/index.mdx:41-48`, `docs/concepts/built-in-tools.md:294-321`.

```ts
// agent/tools/agent.ts
import { disableTool } from "eve/tools";
export default disableTool();
// agent/tools/task_cancel.ts
import { disableTool } from "eve/tools";
export default disableTool();
```

### Leftover the plan does not mention: the `reviewer` subagent

- `agent/subagents/reviewer/agent.ts` is a static declared subagent. Declared subagents are runtime-visible tools
  named by their id (`runtime/subagents/registry.js`: the "collides with another runtime-visible tool name" check;
  `createPreparedRuntimeSubagentTool`), and run as child sessions that inherit the parent's auth
  (`subagents/tool.js`). Disabling `agent` does **not** remove it. Nothing in the repo calls it (`review` tool calls the
  router directly, `agent/tools/review.ts`; grep for `subagents/reviewer` finds only its own files and plan docs).
- It also keeps `subagentsAvailable` true in `composeRuntimeBasePrompt` (`runtime/prompt/compose.js`; true when any
  tool is a `subagent` or `remote`), which appends the "Agent messaging" block to the system prompt (about 230 words,
  about 300 tokens). That block tells the model to "Use task_cancel with its taskId", a tool that no longer exists.
- Decision for the owner or PR A: delete `agent/subagents/reviewer/` (no references), or leave it and accept the
  dangling `task_cancel` sentence and a callable reviewer child session. Deleting also lets `defaultTools`-style
  payload diffs assert "no agent, no task_cancel, no reviewer, no Agent messaging block".
- `reviewerWindowTokens` in `agent/lib/model-window.ts:~118` exists only for this subagent; check before deleting.

### Fallback: `defaultTools: false`

`applyDefaultToolPolicy` (`compiler/default-tool-policy.js`) drops every `tools/*` candidate from the framework-default
layer unless the app authors the same slot or it is `tools/connection_search`. Defaults registered
(`framework/sources/registry.js`): `bash, read_file, write_file, todo, web_fetch, load_skill, connection_search,
ask_question, task_cancel, web_search` (all local nodes) and `agent` (root only).

This repo already authors `bash, read_file, write_file, web_search` (`agent/tools/`), so they stay. To keep what the
prompt names, `defaultTools: false` needs four re-add files, each `export { default } from "eve/tools/<name>"`:

| Re-add | Why |
|---|---|
| `todo` | named in `final/instructions.md:20` |
| `ask_question` | named at `:14`, and in today's `agent/instructions.md:40` |
| `web_fetch` | named at `:51`; PR A also wraps it with `wrapUntrusted`, which is an authored file anyway |
| `load_skill` | **easy to miss**: it appears only when skills exist (`built-in-tools.md`), and PR C adds the skills `connect-apps` and `about-useful-bot`. With `defaultTools:false` and no authored file, those skills would be advertised but unloadable |

`connection_search` stays (required set). Opt-in tools (`glob`, `grep`, `sleep`, `Workflow`) are not defaults, so nothing
else is affected. Non-tool framework sources (`agent.ts`, `sandbox.ts`, channels) are not touched by the policy
(`!slot.startsWith('tools/')`).

Recommendation: `disableTool()` twice. Smaller blast radius, no way to silently lose `load_skill`, and the payload
probe's tool-list diff has one assertion: exactly `agent` and `task_cancel` (and `reviewer`, if deleted) are gone.
Keep the `defaultTools: false` list above in the probe as the "what must still be there" check.

---

## What to change in the plan

1. Section 2, "inside eve, dispatch refuses ...": an instruction resolver that throws is skipped (finding 1.1). Put
   the in-eve backstop in the `step.started` model resolver, and keep the channel 403 as the primary refusal.
2. Section 4 "(including an empty one)": a blank recall string throws. Use a sentinel record, and note that
   recall cannot retract (so the sentinel is required after the last note is deleted).
3. Section 4 "recall returns nothing on a store error": returning null leaves the previous record. Fine, but it is
   stale-not-empty.
4. Section 5.2: add "policy never throws, wraps everything, caps the wait at about 150 s" and "one live run with a
   4+ minute wait" to the OpenAPI evals.
5. Section 5.4: disable `reviewer` too, or accept the dangling prompt block.
6. JWT: the proxy takes the bot from the durable session binding by path, never the body. `channelAuth` must also
   claim on stream and cancel routes with the bot, and the resolver must write the first binding because create is
   not claimed.
