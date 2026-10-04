# UB-009 final check: Claude Fable 5.1 (high)

Date: 2026-10-01. Read-only pass on `docs/plan/UB-009-AGENT-CONTEXT-PLAN.md`, `final/instructions.md`,
`final/context-blocks.md`, `synthesis-draft.md`, `round2/*.md` (Sonnet 5.5, GPT-6.1-Sol, Muse Spark 1.3;
Space Bunny's round-2 file is a three-line stub with no findings), `packet.md` (skimmed) and
`docs/audit/UB-009-GENERALIST-PROMPT.md`. Claims checked against the working tree and
`node_modules/eve/docs` plus `node_modules/eve/dist` where the docs were not enough. No file edited, no git,
no build, no app, no model call.

## Verdict

**Ready with fixes.** The architecture is sound in eve's real lifecycle and every critical/high round-2 finding
is either resolved or declined with a reason. Three things have to change before PR A starts: the auto-loaded
notes block has no size cap (up to 6 x 8,192 bytes per turn), the first-run "no Composio key" path lost its
guidance, and PR A's cross-bot and memory rules would run on today's `activeBotId` fallback before PR B's
binding exists.

## Findings

```json
[
  {
    "finding": "The 'Your notes' block has no size bound. The plan says the 6 most recent notes load 'in full' and 'the read clip matches the write cap'. The write cap is 8,192 bytes per note (agent/tools/memory_upsert.ts:25, agent/lib/memory.ts:370); today's read clip is 1,024 (memory.ts:350). So the block can reach ~49 KB (~12k tokens) on every turn of every bot, more than the whole fixed envelope the plan is trying to shrink, and on a small local model the admission check will refuse the bot's own chat because of its own notes. Titles are also uncapped in the block.",
    "severity": "high",
    "section": "Plan 4 (memory); context-blocks 3",
    "fix": "Cap each auto-loaded body (about 1,200 characters, then '... open with memory_read') and the whole block (about 6,000 characters, then fall back to titles for the rest); cap titles at 80 in the block; count the block in the admission envelope. Keep memory_read uncapped at 8,192 so 'in full' is one call away. State the numbers in section 4."
  },
  {
    "finding": "First-run path with no Composio key is unguided. connector_catalog returns a bare {status: 'blocked', error: 'connectors_not_set_up'} with no hint (agent/tools/connector_catalog.ts:20). The old prompt gave the two setup steps; the new instructions.md routes to the connect-apps skill only for 'Anything outside the catalogue', and the Apps bullet assumes the catalogue answers. A clean install asked to 'connect my Gmail' gets this status on its first tool call and improvises.",
    "severity": "high",
    "section": "instructions.md 'Tools' (Apps bullet); plan 7 (skills); plan 9 behavior eval",
    "fix": "Apps bullet: 'Not connected: connector_catalog, then propose_connector for one app, and end the turn. connectors_not_set_up, or anything outside the catalogue: load_skill connect-apps.' Also give the tool result a hint ('load_skill connect-apps') so a model that skims still lands there. Add the no-key clean install to the 30-scenario behavior eval."
  },
  {
    "finding": "PR A (cross-bot rule, memory scoping) lands before PR B (durable binding), but it must identify the caller. Today activeBotId falls back to shell.selectedBotId when the session is unbound (agent/lib/active-bot.ts:17-20), and the shell pointer misses a session's first turn (model-window.ts awaitTurnStamp comment). So between A and B a racing teammate turn, a routine's first run or a stale pointer makes the rule key on whichever bot the owner has selected, usually the Generalist: orchestrator powers and the Generalist's notes for a teammate.",
    "severity": "high",
    "section": "Plan 8 (PR order); plan 2 'Durable session ownership'",
    "fix": "Either ship the binding store and the fail-closed activeBotId (unbound session => bot_context_missing refusal for in-app and memory tools, never selectedBotId) as the first commit of PR A, or split PR B's binding store out as PR B0 and land it before A. Say which in section 8."
  },
  {
    "finding": "The memory slot has the same first-turn race as the resolver, and the plan specifies the wait only for the resolver ('Notes travel separately'). eve resolves a slot's scope(ctx) before recall; returning null disables the slot silently for that operation (docs/memory/overview.mdx 'Scope'), and a throwing recall['turn.started'] fails the turn before the model call (docs/memory/custom-provider.md:175). So an unbound first turn either runs with no notes (null scope) or retires the chat (throw).",
    "severity": "medium",
    "section": "Plan 4 (memory spike); plan 2 'Turn snapshot'",
    "fix": "Have scope read the same JWT claim/binding snapshot as the resolver, with the same bounded wait (in the recall handler if scope must be sync, with scope returning the session id). Recall returns null on a store error, never throws, so a notes failure cannot retire a chat. Cold-start eval asserts the notes record is present on turn 1, not just the system block."
  },
  {
    "finding": "Group sessions have no class in the cross-bot rule. The rule names 'a plain bot' (kind bot, not default) and 'the orchestrator' (default bot or first visible bot). A group session's bound bot is the group row (kind 'group', agent-exec receiverOf). Sonnet r2 finding 4a asked for this; the plan resolved the context block (slim variant) but not tool authority or whose notes a group session loads.",
    "severity": "medium",
    "section": "Plan 3 'Cross-bot reach' and 'Orchestrator'",
    "fix": "State: a group session acts on itself (its own routines, clear_history on the group chat, memory under the group id), may send_to_bot and post_to_group to its own members, and gets no orchestrator-only tool. Its notes are the group's own. Add the group case to the cross-bot eval."
  },
  {
    "finding": "instructions.md states 'Every MCP server or OpenAPI call asks in Auto and is refused in Read only', but the plan's OpenAPI fallback is 'Auto refuses with needs Full access' if the card hook spike fails. The text and the code would then disagree, which is exactly what the audit set out to end. Good news: eve's connection approval option accepts a custom async policy that receives the session context and may return 'approved', 'denied' or 'user-approval' (docs/tools/human-in-the-loop.md:43-57; openapi.mdx 'Approval gates'), so the hook exists and the policy can call sessionPermission, raise the app's own card and return approved or denied.",
    "severity": "medium",
    "section": "instructions.md 'Permission'; plan 5.2; plan 8 spike list",
    "fix": "Record the expected spike shape (custom approval policy on defineOpenAPIConnection, app card inside it) and make the PR C sentence follow the spike result. Honor toolsAllow through operations.allow in the same change."
  },
  {
    "finding": "The approved-bash profile is underspecified. 'A permissive sandbox profile that still denies planted config and credentials' would, if 'credentials' means today's credential-store read and write denies, refuse an owner-approved gh auth login, codex login or npm login (they write their stores). The current design is 'A line the owner approved runs as they read it' (agent/tools/bash.ts comment before the executeIfApproved call), and the approved line is the only remaining sign-in route once the prompt stops advising the model to authenticate.",
    "severity": "medium",
    "section": "Plan 5.1 (planted config, approved bash)",
    "fix": "Define the approved-line profile as: (allow default), planted-config write denies and the PATH-directory denies (lifted for install_cli), nothing else. Credential stores stay reachable because the owner read the line. State what 'fails closed if the profile can't load' means (the approved line is refused with a plain error, not run bare)."
  },
  {
    "finding": "Memory laundering is accepted but unmarked. memory_upsert runs with no card in Auto and Full, and the 6 most recent notes now load on every turn of every session, so a page or a handoff can plant a durable 'fact' that reads as an instruction and comes back next session labelled only as a fact. The plan tracks 'suggested after reading outside content' for profile edits but not for notes. (eve excludes recalled records from the compaction summary, so the record itself is the only copy, which helps.)",
    "severity": "medium",
    "section": "Plan 4 (labeling); plan 3 'Profile edits'",
    "fix": "Reuse the trusted delivery-metadata tracking: a note written or edited in a turn after untrusted content gets source 'model-after-outside-content', rendered in the block as '(written after reading outside content)' and shown in Settings with one-click delete. The injection eval (page asks for a note write) asserts the marker on the next turn's payload."
  },
  {
    "finding": "The admission envelope omits the carry-over brief and the non-proxy send path. BRIEF_MAX_CHARS is 32,000 (~8k tokens, shared/continuation-brief.ts:28-29) and lands on the first turn of a replacement session, the turn right after a retire. GPT r2 finding 8 named it; the plan's envelope lists instructions, description, notes, tool schemas and output reserve. Admission is also described for 'the proxy' only, while routines and handoffs go through runEveTurn (web/lib/agent-exec.ts:649), which posts straight to eve.",
    "severity": "medium",
    "section": "Plan 2 'Admission check'",
    "fix": "Size the brief from the bot's frozen window (maxChars already exists) and count it in admission on carry-over turns. Run the same admission check in runEveTurn before the POST."
  },
  {
    "finding": "Orchestrator fallback (Generalist deleted, first visible bot takes over) is half-defined. propose_group excludes only DEFAULT_BOT_ID from membership (shared/shell-store.ts:651), rail_action and delete_bot protect only bot-useful (rail_action.ts:139, delete_bot.ts:41), and 'Running the team' opens with 'You are the owner's main assistant' while that bot's own instructions say it is, say, the Mailer.",
    "severity": "low",
    "section": "Plan 3 'Orchestrator'; context-blocks 1",
    "fix": "Make the code's orchestrator rule one helper used by propose_group membership, rail_action and delete_bot too. In the fallback case drop the first sentence of 'Running the team' (keep the bullets)."
  },
  {
    "finding": "instructions.md Auto sentence 'With no folder, only new files skip the card' reads as a general rule but is only true for files and commands: in-app actions (rail, routines, memory) run at once in Auto with no folder (agent/lib/permission.ts:25-29) and catalogue reads run everywhere. A model will over-ask or narrate phantom cards.",
    "severity": "low",
    "section": "instructions.md 'Permission'",
    "fix": "'With no folder, for files and commands only new files skip the card.'"
  },
  {
    "finding": "The 'several system messages' rationale for one resolver does not hold as stated: the plan still sends two system rows (instructions.md plus the resolver), and today three already reach local servers unchanged through router/src/upstreams/openai-chat.ts (it does not touch roles). One resolver is still right (one wait, one marker, deterministic order), the template claim is not.",
    "severity": "low",
    "section": "Plan 2 'One resolver'",
    "fix": "Drop the template sentence, or fold the leading system run into one row in openai-chat.ts and verify on one Ollama model."
  },
  {
    "finding": "Retirement on the in-eve backstop is asserted, not verified. hooks.md:179 says a thrown turn.started or first step.started handler ends with session.waiting and the next message starts another turn; the retire the app knows comes from the upstream-rejection cascade (sessions-runs-and-streaming.md:164, memory note 'eve failed turn retires the session'). Either outcome is acceptable; the plan should not promise one.",
    "severity": "low",
    "section": "Plan 2 'Fail closed'",
    "fix": "Word it 'may retire the session' and have the cold-start eval record which happens, with the session state after a bot_context_missing refusal."
  },
  {
    "finding": "Two round-2 items are dropped without a note: Muse 16(a) (the file-tool root stays rooted in Full access while shell reach does not; 'This turn' says only 'folder NAME attached') and Muse 16(c) (name the review tool once). Muse 7's .vscode/tasks.json is dropped from the planted list without saying why (the plan keeps .mcp.json and .cursor/mcp.json). Sonnet's low about 'No em dashes' being the author's rule shipped to every owner is not addressed either way.",
    "severity": "low",
    "section": "Plan 3, 5.1, 10",
    "fix": "One line each in section 10: tasks.json dropped (needs a Run Task, not a launch); review stays in its tool description; the root/shell distinction is in the tool results; em dashes kept or dropped as the owner decides."
  },
  {
    "finding": "The seed overlay's key is not stated. 'Append-only seed list with an exact match applied as a pure overlay in parseShell' must apply only to id === DEFAULT_BOT_ID; an owner-made bot whose text happens to equal an old seed string must not be rewritten. The rename rule names the id implicitly; the description rule does not.",
    "severity": "low",
    "section": "Plan 3 'Shipped Generalist text'",
    "fix": "Add 'only on bot-useful' to the row and to the seed-overlay eval."
  },
  {
    "finding": "Removing the shared-phone audience needs a migration line: notes stored with audience 'shared-phone' are filtered out by every audience-scoped query (memory.ts:269-309) and would vanish from search, read and Settings.",
    "severity": "low",
    "section": "Plan 4 'Scoping in code'",
    "fix": "Fold existing shared-phone rows to desktop in the same migration that assigns untagged notes to the Generalist."
  },
  {
    "finding": "No 'owner is new' signal reaches the model. The shipped Generalist text says 'When the owner is new, explain the app only as far as their task needs', but nothing in 'This turn' says it is the first chat; the app knows (StarterPrompt.sentKey, FirstRunGate).",
    "severity": "low",
    "section": "context-blocks 4 and 5",
    "fix": "Optional: the proxy appends 'This is the owner's first chat on this Mac.' to 'This turn' while the bot has no completed turn; or cut the sentence from the shipped text."
  }
]
```

## Round-2 findings, accounted for

Checked every critical/high in `round2/sonnet-5.5.md`, `round2/gpt-6.1-sol.md` and `round2/muse-spark-1.3.md`
against the plan. None is silently dropped. The ones that changed shape:

- Sonnet 3 and GPT 4 (pinned notes laundering): moot because the owner replaced pinning with "6 most recent";
  the laundering concern transfers to the auto-load and is finding 8 above.
- GPT 8 (admission): adopted, but the carry-over brief half of it is missing (finding 9).
- GPT 11 (model-facing history rewrite): declined with a reason (eve API has no projection). Correct.
- Muse 13 (rollout flag): declined with a reason. Correct, and consistent with the global "simplest code" rule.
- Sonnet 12 / Muse 5 (small windows): the admission refusal replaces the "compact profile below 24k" idea; the
  plan does not say so, but admission is the stronger guarantee. Fine.
- Space Bunny round 2: both attempts produced nothing (`space-bunny.md` is three progress lines). Section 10
  says "Re-run"; the record should say the seat gave no round-2 critique.

## Architecture against eve's lifecycle (verified)

- `turn.started` dynamic instructions: system results live outside history, survive compaction and clear, and
  every turn starts fresh so a failed resolver cannot leak the previous turn (`docs/instructions.mdx:77-89`,
  `docs/guides/dynamic-capabilities.md` "Returning null or blank content..."). A throwing resolver is skipped,
  not fatal, so failing closed at dispatch (proxy and `runEveTurn` first, the `step.started` model resolver as
  backstop) is the right shape. `step.started` freeze and `turnIdOf` exist (`agent/agent.ts:185-199`).
- JWT bot claim: `jwtHmac` builds the principal through `createJwtAuthenticatedCallerPrincipal`, whose
  `attributes` come from `createJwtAttributeProjection(payload)` (`dist/src/channel/auth/token-claims.js`), so
  custom claims do reach `ctx.session.auth.current.attributes`. The spike premise holds. Note the eve channel's
  create route has no client-chosen session id (`docs/channels/eve.mdx` "operationId" is create-once, the id is
  server-assigned), so the JWT claim is the only race-free route; polling is a real fallback.
- Memory slot: recall results are user-role, attributed to the slot, never promoted to system; a later record
  with the same id supersedes; recall cannot retract; `recall["compaction.completed"]` re-recalls against the
  new checkpoint and recalled records are excluded from the summarizer (`docs/memory/custom-provider.md:113-175`).
  The "one aggregate record replaced on every recall, including empty" design is the right reading of it.
- Sessions: `session.failed` is terminal; `409 session_not_active` is what the proxy handles today
  (`route.ts:289-294`). See finding 13 for the backstop's exact outcome.
- Approval policy for OpenAPI: custom async policy with session context exists (finding 6).

## Texts against the code

- `instructions.md` is 913 words by `wc -w`, under the 950 cap. Every backticked tool name exists in
  `agent/tools/` or is eve's (`todo`, `ask_question`, `web_fetch`, `load_skill`), except `memory_delete`, which
  PR B adds before PR C's CI check runs.
- MCP: "Every MCP server ... call asks in Auto and is refused in Read only" matches `mcpToolGate`
  (`agent/lib/connector-risk.ts`); `toolsAllow` only filters visibility, so the Excalidraw draw lines are
  consistent (a card per call in Auto, which is true).
- Catalogue: "reads run in every mode; writes ask in Auto" matches `connectorGate`.
- Tripwire: "refused by every tool ... so `.gitignore` too" matches `resolveWorkspacePath`
  (`agent/lib/workspace.ts:132-135`, substring, lower-cased) and the bash tripwire. CI workflows and git config
  are already caught by the `.git` substring, so the "Never write config another program runs later" sentence
  asks for nothing the code allows.
- Full access: "no execution cards, except wiping..." plus "New bots, profile changes, groups, group posts and
  connections always show a card" matches `bash.ts`, `inAppGate` and the proposal tools.
- `post_to_group` already lets a teammate post (`sourceBotId` non-default), so G1 is correctly an owner decision.
- `list_bots` note "The default bot (bot-useful) is you" (`list_bots.ts:64`) and the camelCase hints in
  `clear_history`, `create_routine`, `rail_action`, `send_to_bot` are PR C items; listed, not missed.
- "This turn" fields are serialized per the rules in context-blocks 2; the model label and connection label
  come from remote model lists, so the 80-character flatten matters there too (covered).
- Ambiguity for a model: only the Auto sentence in finding 11. "Ask first" is clear enough with the
  "Unless the owner asked for it in this request or set it up as a routine" opener; P2 is correctly the owner's.

## Security

- Injection: owner text sits inside `<owner-instructions>` with the closing tag escaped; notes are user-role or
  fenced; tool outputs wrapped, `web_fetch` and `review` to be wrapped. Sound. Residual: finding 8.
- Cross-bot: rule at execution time in `permission.ts`; `create_routine`, `rail_action`, `clear_history` take
  any `botId` today (verified), so the rule is needed and the eval covers it. Gap: group class (finding 5) and
  ordering (finding 3).
- Planted config: the shared-names-two-compilers design matches `sandbox.ts` (names compiled to SBPL regexes
  with the `.sample` and hooks-directory exceptions). Case-insensitivity is a spike, right. Approved-line
  profile needs the definition in finding 7.
- OpenAPI: mounted eagerly with no approval (`agent/connections/registry.ts`), so the gate is real work; the
  policy hook exists (finding 6).
- Memory: SQL filter before `LIMIT`, immutable ownership, upsert refuses foreign ids, `botId` input removed,
  expiry on read. Sound.

## Migration risk for existing installs

- Old teammate sessions keep the "Standing instructions" prefix in history: the one-line notice in "Your bot"
  is the right mitigation; the carry-over path at `agent-exec.ts:719` also builds the prefix and must go with
  the proxy's.
- Shell pointer already binds sessions (`bots[].sessionId`, `continuedSessionId`), so backfilling the new store
  from it covers every live chat. `SessionGrant` eviction at 64 no longer matters for identity.
- Seeds: UB-010 landed with `pinned: true` in `seedStore` and `withNewBot`, no marker, so the overlay does not
  fight another marker. Key it on `bot-useful` (finding 15).
- Memory: untagged notes to the Generalist is stated; shared-phone fold is not (finding 16).
- `parseShell` clips descriptions at 500 on read today (`shell-store.ts:293`); raising that clip to 8,000 in PR B
  is implied by "across every path" and must land before the editor allows longer text.

## DISMISSED (checked, found sound)

- One resolver, one system message after `instructions.md`, deterministic order: sound (only the template
  rationale is off, finding 12).
- Turn snapshot shared by the resolver, the `step.started` freeze and `list_models`: sound; `resolveTurnSelection`
  already exists to compute it from one store read and one roster read.
- Child sessions disabled until grants propagate: sound; `review` calls the router directly and is unaffected.
- `disableTool()` for `agent` and `task_cancel`: documented (`docs/concepts/built-in-tools.md:6,60`); the
  `defaultTools: false` fallback is also documented.
- `web_fetch` override wrapping with `wrapUntrusted`: documented pattern (`built-in-tools.md:147-160`); SSRF
  checks stay in the built-in.
- Fail-closed before dispatch in the proxy and `runEveTurn`, in-eve refusal as a logged, counted backstop: sound.
- Durable session->bot store, immutable, written on create/continue/routine/handoff/409 carry-over: sound; the
  409 path in `agent-exec.ts:700-760` is where the new session id appears and can be bound.
- Description 8,000 cap, refused never clipped, across store, `parseShell`, `agent-store` (clips at 500 today,
  `:325,:346`), tool schemas (`max(500)` today) and group descriptions (`propose_group` accepts and drops it
  today): the enumeration is complete.
- `propose_bot` capped at 2,000: sound asymmetry.
- Seed overlay as a pure function in `parseShell`, persisted by the next `updateShell` (`mutate(readShell())`,
  `shell-io.ts:229`): no lock recursion, idempotent. Rename condition now includes the name check.
- Profile edits: self-only for plain bots, full text and diff, approval bound to text and revision, taint from
  trusted delivery metadata, one pending per bot: sound and complete for `update_bot_profile`.
- Peer messages: "a handoff is a task for your own role, bounded by your permission" resolves the audit's
  contradiction; envelope keeps group and relay-hop lines; routine line added. Sound.
- Groups: slim variant, no impersonation, `speakerLabel` fixed, real mention routing deferred and said so. Sound
  apart from finding 5.
- Per-turn facts in the system block, day-granular date, cache eval as the gate with a stated fallback: sound.
- Serialization rules (flatten, strip control characters, cap 80, unclosable boundary, hostile fixtures): sound.
- Legacy prefix notice instead of a history rewrite: eve has no model-facing projection; correct.
- `list_bots` summaries at 200 characters with full text on request: sound.
- Tool-description trim in PR C measured from a fresh compile: sound; phase-2 schema hiding deferred with a
  measurement gate.
- Memory scoping in SQL, immutable ownership, upsert refusal, expiry on read, `source` shown, `settle(ctx)`:
  sound. `memory_delete` gated like `memory_upsert`: sound.
- Planted config: `.mcp.json` and `.cursor/mcp.json` as files, not directories; reads open; F1 as an owner
  decision: sound.
- `review` output fenced: `review.ts:57` returns model text unwrapped today; the fix is right.
- OpenAPI zero-side-effect test list (denial, expiry, replay, changed args, narrowed permission, repointed
  connection, `list_items` that mutates): complete.
- No rollout flag, rollback by revert and dev rebuild: consistent with the global rules.
- Settings pane designed first with the useful-design skill, frame-by-frame recording of motion: matches the
  UI rules.
- PR order A, B, C with C last and the prefix builders removed in a later commit of B: right, subject to
  finding 3.
- Evals list: covers payload, cold start, mid-session edit, model switch, compaction, 409, cross-bot, injection,
  planted config, OpenAPI, seed overlay, cache, small models, behavior. Add the three asserts named in findings
  1, 4 and 8.
- Owner decisions P1, P2, G1, F1, S1 and the two deferred items: correctly left to the owner; S1 is backed by
  `ChatView.swift:2271-2300` (the PDF and screenshot starters) and `read_file` being UTF-8 only.
- Shipped Generalist text (context-blocks 5): nothing in it conflicts with the shared prompt or the code; the
  duplicated teammate rule was removed as Sonnet asked.
- Dismissals in plan section 10: Space Bunny E2 now worded as "no double-send, moot"; MiMo's two items declined
  with reasons; Muse's flag declined with a reason. All correct.
