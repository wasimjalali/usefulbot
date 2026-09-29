# Launch audit scoreboard

Started 2026-09-15. Orchestrated by Claude Code (Fable 5.1). Two auditor models run
through opencode at max reasoning: `opencode-go/muse-spark-1.3-contributor` (Spark)
and `opencode-go/glm-5.3-flash` (GLM). Each finding is verified by the orchestrator
against the code before it counts. Patches are handed to the models in turn and
scored on whether they were mergeable as delivered.

Earlier plan-level verdicts from the same models live in `docs/counsel/`.

## Method

- Slices: `mac-app` (macos/Sources/UsefulBotApp), `mac-core` (macos/Sources/UsefulBotCore),
  `web` (web/), `agent-router` (agent/, router/src), `shared-scripts` (shared/, scripts/).
- Each model reads the slice read-only and returns a JSON array of findings with file,
  line, severity, repro and fix. Same brief for both models, run in parallel.
- Verification outcomes: **confirmed** (real, patch it), **partial** (real problem, but
  the repro or cause is wrong, or no user impact), **false** (not a bug or unreachable),
  **dup** (same defect the other model, or the same model, already reported; Spark's
  runs finished first, so a shared find is usually credited to Spark and marked dup
  for GLM. Both found it independently).
- Patch outcomes: **mergeable** (landed as delivered), **rework** (landed after the
  orchestrator or the Spark review changed it), **redo** (thrown away, orchestrator
  patched it). Patch batches are split by file so the two models can run at once.
- One PR per slice, reviewed by a Spark pass before merge: #48 macOS, #49 web, #50 agent and shared, all merged 2026-09-15. Findings the orchestrator
  adds while verifying carry the `ORCH` prefix.

## Running totals (round 1)

| Model | Reported | Confirmed | Partial | False | Dup | Precision, non-dup findings that were real |
|-------|---------:|----------:|--------:|------:|----:|----------:|
| Spark | 37 | 26 | 5 | 5 | 1 | 86% (31 of 36) |
| GLM   | 39 | 25 | 2 | 0 | 12 | 100% (27 of 27) |

Reading the numbers: Spark is roughly twice as fast per slice and reports more, with a
handful of unreachable or by-design findings mixed in. GLM is slower, reports nothing
false so far, and found the two highest-impact defects of the round on its own (the
missing bot persona on server-driven turns, and the acting-bot resolution that nothing
ever sets).

| Model | Patches | Mergeable | Rework | Redo | Notes |
|-------|--------:|----------:|-------:|-----:|-------|
| Spark | 26 | 22 | 4 | 0 | macOS batch A, web batch D, agent batch G. Reworks: the Stop reload still blanked the chat during replay; late save errors not scoped to the bot; the web draft cleared before the body parsed; the banner Retry re-sent the fenced blob. The agent batch (stores, router search gate, scripts) reviewed clean. |
| GLM   | 28 | 25 | 3 | 0 | macOS batches B and E, web batch C, agent batch F. Reworks: the settings reseed watched the whole bot struct; an unguarded roster read in the persona prefix; one new test did not typecheck. |

Both models produced patches that landed as delivered most of the time. Every rework was
small (one hunk) and was caught by the Spark review pass or the typecheck, not by a user.

## Round 1

### Runs

| Slice | Model | Wall time | Findings | Notes |
|-------|-------|----------:|---------:|-------|
| web | Spark | 2m45s | 6 | Read every listed file plus the shared stores. |
| web | GLM | 8m17s | 9 | Slower, wider net: caught the missing persona on server-driven turns. |
| mac-core | Spark | 3m29s | 5 | Cross-checked Swift against the TypeScript ports. |
| mac-core | GLM | 14m22s | 4 | Found the mid-turn EOF being treated as a clean end. |
| mac-app | Spark | 4m26s | 8 | State-flow reasoning through AppModel. |
| mac-app | GLM | 9m33s | 6 | Deeper lifecycle bugs (cancel, stream failure, task cancellation). |
| agent-router | Spark | 5m07s | 7 | Reviewer never provisioned, search endpoint unthrottled. |
| agent-router | GLM | 12m44s | 11 | Acting-bot resolution, reviewer headers, bash maxBuffer. |
| shared-scripts | Spark | 3m56s | 11 | Store durability sweep, 12h token expiry, rotate ordering. |
| shared-scripts | GLM | 14m06s | 9 | Mostly the same store findings, plus two script nits. |

### Findings

Severity is the auditor's. The verdict column is the orchestrator's after reading the code.

| ID | Model | Sev | Kind | File:line | Title | Verdict | Patch by | Patch result | PR |
|----|-------|-----|------|-----------|-------|---------|----------|--------------|----|
| S-WEB-01 | Spark | high | bug | web/app/api/routines/[id]/run/route.ts:38 | Test run answers started before the claim | partial: the double click is closed by the synchronous in-flight set, but a claim that throws is swallowed with no history row | GLM | mergeable | #49 |
| S-WEB-02 | Spark | high | ux | web/components/bot-settings-panel.tsx:172 | Routines pane says the scheduler is not wired | confirmed | Spark | mergeable | #49 |
| S-WEB-03 | Spark | medium | bug | web/components/app-settings-dialog.tsx:394 | Usage meter ignores reserved tokens | confirmed | Spark | mergeable | #49 |
| S-WEB-04 | Spark | low | ux | web/components/app-settings-dialog.tsx:400 | "This week" label over 24h numbers | confirmed | Spark | mergeable | #49 |
| S-WEB-05 | Spark | high | bug | web/components/proposal-card.tsx:128 | Group-less fanout sends to one bot | false: post_to_group is the only fanout creator and always sets groupId | | | |
| S-WEB-06 | Spark | medium | ux | web/app/page.tsx:354 | Failed send leaves the rail preview | confirmed (web only; the Mac app stamps the preview after the send is accepted) | Spark | rework: the draft was cleared before the body parsed (Spark review) | #49 |
| S-MACCORE-01 | Spark | low | bug | macos/Sources/UsefulBotCore/ChatMarkdown.swift:190 | Table cell drops backslash | confirmed | GLM | mergeable | #48 |
| S-MACCORE-02 | Spark | medium | bug | macos/Sources/UsefulBotCore/EveStream.swift:240 | stripThreadPrefix looser than the TypeScript regex | confirmed, low in practice | GLM | mergeable | #48 |
| S-MACCORE-03 | Spark | medium | ux | macos/Sources/UsefulBotCore/BackendClient.swift:354 | shell() drops the server error code | confirmed | GLM | mergeable | #48 |
| S-MACCORE-04 | Spark | low | reliability | macos/Sources/UsefulBotCore/ServiceSupervisor.swift:51 | isNodeAvailable bypasses injected predicate | partial: real, but a test seam with no user impact; not patched | | | |
| S-MACCORE-05 | Spark | low | bug | macos/Sources/UsefulBotCore/Threads.swift:67 | Mention roster capped at 64 | false: documented bound against unbounded regex, roster never approaches it | | | |
| S-MACAPP-01 | Spark | high | bug | macos/Sources/UsefulBotApp/AppModel.swift:606 | Send no-ops on stale selectedBotId | false: every store write reconciles the selection synchronously, so the stale state cannot be observed | | | |
| S-MACAPP-02 | Spark | medium | ux | macos/Sources/UsefulBotApp/ChatView.swift:35 | Thread error has no retry | confirmed | Spark | mergeable | #48 |
| S-MACAPP-03 | Spark | medium | ux | macos/Sources/UsefulBotApp/PickerViews.swift:221 | Search tabs Files/Links/Routines/Actions never return results | confirmed | GLM | mergeable | #48 |
| S-MACAPP-04 | Spark | high | ux | macos/Sources/UsefulBotApp/ChatView.swift:132 | Approval with empty hash is a dead card | false: listPending always carries actionSha256, the empty string is a decode fallback | | | |
| S-MACAPP-05 | Spark | medium | data | macos/Sources/UsefulBotApp/SettingsPaneView.swift:285 | Settings fields seed once and clobber server renames | confirmed | GLM | rework: reseed watched the whole struct, so a just-committed edit flickered back until its echo | #48 |
| S-MACAPP-06 | Spark | low | ux | macos/Sources/UsefulBotApp/AppModel.swift:1332 | saveError leaks across bots | confirmed | Spark | rework: a save failing after a switch still painted the new bot | #48 |
| S-MACAPP-07 | Spark | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:1549 | Proposal buttons re-enable before reload | confirmed | Spark | mergeable | #48 |
| S-MACAPP-08 | Spark | medium | ux | macos/Sources/UsefulBotApp/AppSettingsView.swift:552 | Typed budget only commits on Return | confirmed | GLM | mergeable | #48 |
| S-AGENT-01 | Spark | high | bug | agent/tools/review.ts:11 | review tool returns fixture text as success without a token | confirmed: the reviewer token is never provisioned by scripts/service.mjs | GLM | mergeable | #50 |
| S-AGENT-02 | Spark | high | reliability | router/src/index.ts:429 | /v1/search bypasses rate limits, budgets and the concurrency gate | confirmed | Spark | mergeable | #50 |
| S-AGENT-03 | Spark | medium | reliability | shared/workspace-store.ts:183 | Workspace lock timeout shorter than stale window | dup of S-SHARED-01 (same run family) | | | |
| S-AGENT-04 | Spark | medium | bug | agent/tools/memory_upsert.ts:29 | memory_upsert consumes the approval before validating | confirmed | GLM | mergeable | #50 |
| S-AGENT-05 | Spark | medium | ux | agent/tools/memory_upsert.ts:33 | Memory approval card shows only the title | confirmed | GLM | rework: the test it added did not typecheck (a helper's return type) | #50 |
| S-AGENT-06 | Spark | low | data | agent/lib/memory.ts:355 | Memory upsert misses tag length and expiry validation | partial: the schema has no maxima, the expiry corruption claim is not verified | GLM | mergeable | #50 |
| S-AGENT-07 | Spark | low | reliability | agent/agent.ts:19 | SSE sleep leaks abort listeners | partial: that code is the S2 fixture path only, never runs in production; not patched | | | |
| S-SHARED-01 | Spark | high | reliability | shared/workspace-store.ts:183 | Workspace lock timeout shorter than its stale window | confirmed | Spark | mergeable | #50 |
| S-SHARED-02 | Spark | critical | data | shared/providers.ts:163 | providers.json written in place, reader throws | confirmed | Spark | mergeable | #50 |
| S-SHARED-03 | Spark | high | data | shared/connectors-store.ts:92 | Corrupt connectors.json throws forever | confirmed | Spark | mergeable | #50 |
| S-SHARED-04 | Spark | high | data | shared/web-sessions.ts:40 | Corrupt session file silently replaced | confirmed | Spark | mergeable | #50 |
| S-SHARED-05 | Spark | medium | reliability | shared/handoffs.ts:336 | dropHandoff passes dir as the claim token | confirmed | Spark | mergeable | #50 |
| S-SHARED-06 | Spark | medium | bug | shared/handoffs.ts:290 | markDelivered read-modify-write without a lock | false: every caller passes the claim token and ownership is checked first, so two pumps cannot both write | | | |
| S-SHARED-07 | Spark | low | bug | shared/composio-catalogue.ts:42 | Catalogue memo ignores its path | confirmed, tests only in practice | Spark | mergeable | #50 |
| S-SHARED-08 | Spark | high | reliability | scripts/service.mjs:178 | Web channel token minted once, expires after 12h | confirmed | GLM | mergeable | #49 |
| S-SHARED-09 | Spark | high | data | scripts/setup-local.mjs:70 | --rotate moves the config away before any key is written | confirmed | Spark | mergeable | #50 |
| S-SHARED-10 | Spark | low | bug | shared/composio.ts:409 | disconnectConnector lists only 100 accounts | confirmed | Spark | fixed: walks the cursor, bounded at 40 pages | #112 |
| S-SHARED-11 | Spark | medium | reliability | scripts/verify.mjs:92 | opencode case certifies a stale results file | partial: dev tooling, documented as needing --live; not patched | | | |
| G-WEB-01 | GLM | high | bug | web/lib/agent-exec.ts:309 | Routines and handoffs run without the bot persona | confirmed: runEveTurn never applies threadPrefix; only a session that already carries it from a UI turn keeps the role | GLM | rework: the new roster read was unguarded (Spark review, one hunk) | #49 |
| G-WEB-02 | GLM | medium | ux | web/components/app-settings-dialog.tsx:394 | Usage meter observed-only, mislabelled | dup of S-WEB-03 and S-WEB-04 | | | |
| G-WEB-03 | GLM | medium | ux | web/components/bot-settings-panel.tsx:172 | Routines stub | dup of S-WEB-02 | | | |
| G-WEB-04 | GLM | low | ux | web/components/chat-search-dialog.tsx:20 | Dead search tabs | confirmed (web twin of S-MACAPP-03) | Spark | mergeable | #49 |
| G-WEB-05 | GLM | low | ux | web/app/page.tsx:403 | Failed send restores the fenced attachment blob | confirmed | Spark | rework: the banner Retry still re-sent the blob with the chips left behind (Spark review); the retry was removed | #49 |
| G-WEB-06 | GLM | low | reliability | web/app/api/approvals/route.ts:20 | Approvals GET 500s on a locked store | confirmed | GLM | mergeable | #49 |
| G-WEB-07 | GLM | low | bug | web/app/page.tsx:777 | Picker create inherits stale section | confirmed | Spark | mergeable | #49 |
| G-WEB-08 | GLM | low | bug | web/lib/use-shell.ts:115 | Failed queued save swallowed behind a newer action | confirmed | GLM | mergeable | #49 |
| G-WEB-09 | GLM | low | ux | web/components/chat-composer.tsx:391 | Composer setting change fails silently | confirmed | Spark | mergeable | #49 |
| G-MACAPP-01 | GLM | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:759 | Stop wipes the transcript until a replay | confirmed, arguably high: the chat went blank after Stop | Spark | rework: the reload it added still blanked the chat during replay; orchestrator gated the eager rebuild | #48 |
| G-MACAPP-02 | GLM | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:734 | Stream failure after delivery restores the draft | confirmed | Spark | mergeable | #48 |
| G-MACAPP-03 | GLM | medium | ux | macos/Sources/UsefulBotApp/SettingsPaneView.swift:206 | Edits dropped on close or bot switch | confirmed | GLM | mergeable | #48 |
| G-MACAPP-04 | GLM | low | bug | macos/Sources/UsefulBotApp/AppModel.swift:753 | Stop during the POST orphans the turn | confirmed | Spark | mergeable | #48 |
| G-MACAPP-05 | GLM | low | bug | macos/Sources/UsefulBotApp/ComposerView.swift:795 | Hover task writes @State off the main actor | confirmed | GLM | mergeable | #48 |
| G-MACAPP-06 | GLM | low | bug | macos/Sources/UsefulBotApp/AppModel.swift:1622 | Cancelled memory load paints an error on the next bot | confirmed | Spark | mergeable | #48 |
| G-MACCORE-01 | GLM | high | bug | macos/Sources/UsefulBotCore/BackendClient.swift:1097 | Mid-turn EOF treated as a clean stream end | confirmed | GLM | mergeable (orchestrator shortened the copy) | #48 |
| G-MACCORE-02 | GLM | medium | bug | macos/Sources/UsefulBotCore/EveStream.swift:240 | stripThreadPrefix looser than the contract | dup of S-MACCORE-02 | | | |
| G-MACCORE-03 | GLM | low | reliability | macos/Sources/UsefulBotCore/LocalServices.swift:309 | Termination handler races registry.add, leaking a handle | confirmed | GLM | mergeable | #48 |
| G-MACCORE-04 | GLM | low | bug | macos/Sources/UsefulBotCore/ChatMarkdown.swift:190 | Table cell drops backslash | dup of S-MACCORE-01 | | | |
| G-AGENT-01 | GLM | high | bug | web/lib/agent-exec.ts:309 | Server-driven turns skip the identity prefix | dup of G-WEB-01 (same model, earlier run) | | | |
| G-AGENT-02 | GLM | high | bug | agent/subagents/reviewer/agent.ts:31 | Reviewer subagent cannot pass the router's session headers, wrong token fallback | confirmed | GLM | mergeable | #50 |
| G-AGENT-03 | GLM | high | bug | agent/tools/review.ts:14 | review tool omits the required x-useful headers | confirmed | GLM | mergeable | #50 |
| G-AGENT-04 | GLM | high | bug | agent/tools/create_routine.ts:45 | Nothing sets UB_ACTIVE_BOT_ID, so "this bot" is the selected bot | confirmed: twelve tools resolve the acting bot from a variable nothing sets; a routine or handoff for bot A while B is selected misattributes notes, routines and proposals | GLM | mergeable | #50 |
| G-AGENT-05 | GLM | medium | reliability | agent/lib/approvals.ts:214 | Approval records never pruned | confirmed | GLM | mergeable | #50 |
| G-AGENT-06 | GLM | medium | reliability | router/src/index.ts:435 | /v1/search bypasses rate limits | dup of S-AGENT-02 | | | |
| G-AGENT-07 | GLM | medium | security | agent/lib/write.ts:55 | write_file approval card shows only the path | confirmed | GLM | mergeable | #50 |
| G-AGENT-08 | GLM | medium | ux | agent/tools/memory_upsert.ts:33 | memory approval card shows only the title | dup of S-AGENT-05 | | | |
| G-AGENT-09 | GLM | medium | bug | agent/tools/bash.ts:136 | Output over 1 MiB fails the call with a raw maxBuffer error | confirmed | GLM | mergeable | #50 |
| G-AGENT-10 | GLM | low | data | shared/agents-send.ts:26 | Handoff to a one-member group flips its thread kind | confirmed | GLM | mergeable | #50 |
| G-AGENT-11 | GLM | low | data | agent/lib/memory.ts:457 | tagsForBot drops the bot tag at 8 tags | confirmed | GLM | mergeable | #50 |
| G-SHARED-01 | GLM | high | data | shared/providers.ts:163 | providers.json non-atomic, reader throws | dup of S-SHARED-02 | | | |
| G-SHARED-02 | GLM | critical | reliability | web/lib/agent-exec.ts:114 | Static 12h channel token | dup of S-SHARED-08 | | | |
| G-SHARED-03 | GLM | medium | reliability | shared/workspace-store.ts:184 | Lock stale window exceeds wait timeout | dup of S-SHARED-01 | | | |
| G-SHARED-03B | GLM | medium | data | shared/connectors-store.ts:92 | Corrupt connectors.json throws forever | dup of S-SHARED-03 | | | |
| G-SHARED-05 | GLM | medium | ux | scripts/service.mjs:101 | Router refuses to start without the opencode-go keychain item | partial: by design, the subscription is the primary upstream; not patched | | | |
| G-SHARED-06 | GLM | low | bug | shared/handoffs.ts:336 | dropHandoff passes dir as the token | dup of S-SHARED-05 | | | |
| G-SHARED-07 | GLM | low | ux | shared/threads.ts:214 | stripThreadPrefix can strip a look-alike user message | partial: known trade-off of the prefix scheme; not patched | | | |
| G-SHARED-08 | GLM | low | reliability | shared/live-models.ts:34 | models-cache.json written in place | confirmed | Spark | mergeable | #50 |
| G-SHARED-09 | GLM | low | ux | scripts/service.mjs:162 | Eve startup names the wrong keychain item on failure | confirmed | Spark | mergeable | #50 |
| ORCH-01 | orchestrator | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:772 | Attachments removed at send are not restored when the send fails | found while verifying G-WEB-05 | Spark | mergeable | #48 |

### Landed after the three slice PRs

- #52 `fix(agent)`: eve failed to boot after #50 because the reviewer subagent threw at module
  load when the reviewer token was absent. Found by restarting the services against main,
  not by either auditor or the Spark review of #50. The provider now builds either way and
  the first reviewer call fails with `reviewer_unconfigured`, reading the token per call.
- #53 `feat(agent)`: railAction gained `removeSection` (approval-gated) and `updateSection`,
  from the owner's brief mid-session. Verified live in the app.

### Open for round 2

- ORCH-02 (medium, ux): the macOS rail does not refresh while a turn is running (the store
  poll pauses so the optimistic session echo is not overwritten), so a section or bot a
  tool changed mid-turn appears only after the turn ends. Seen while verifying #53.
- Provision the reviewer credential (profile `reviewer`) in setup-local and service.mjs.
- Re-audit every slice against main with fresh briefs; re-verify the persona prefix on a
  routine run and the acting-bot resolution on a handoff.

### Not patched this round, for the owner

- The reviewer credential (`UB_ROUTER_REVIEWER_TOKEN`, profile `reviewer`) is never minted by
  scripts/setup-local.mjs nor passed to eve by scripts/service.mjs, so "ask the reviewer" can
  only run in fixture mode. The agent-slice patch makes the tool say so instead of returning
  placeholder text. Provisioning the credential is a setup change, not a bug fix.
- The web routines pane is now honest copy pointing at the Mac app. A web routines UI is a
  feature, not a fix, and the web surface trails the app by design.

## Running totals (round 2)

| Model | Reported | Confirmed | Partial | False | Dup | Precision, non-dup findings that were real |
|-------|---------:|----------:|--------:|------:|----:|----------:|
| Spark | 29 | 19 | 5 | 4 | 1 | 86% (24 of 28) |
| GLM   | 33 | 28 | 1 | 0 | 4 | 100% (29 of 29) |

Same shape as round 1. Spark reads a slice in 2.5 to 10 minutes and reports more, with the
by-design and unreachable items mixed in (two router findings the spec settles, one crash
claim a live test refuted, two repeats of round 1 verdicts). GLM takes 11 to 16 minutes, has
reported nothing false in two rounds, and again found the round's highest-impact defects on
its own: a docker binary on PATH stopping eve from booting, the handoff pump never
recovering from a retired session, the dev-only auth backdoor being live in the shipped web
tier, and the open chat never following its session.

| Model | Patches | Mergeable | Rework | Redo | Notes |
|-------|--------:|----------:|-------:|-----:|-------|
| Spark | 27 | 22 | 4 | 1 | macOS batch B, web batch B, agent batch A, shared batch B. Reworks: the ambiguous hint named the wrong tool; the connector throw path kept the truncation; the circuit still recorded success at headers and never counted timeouts; the quote parser shadowed its own name and the view recursed on an opaque type. Redo: disableTool on a top-level tool source made eve exit at boot, reverted. |
| GLM   | 27 | 17 | 10 | 0 | macOS batch A, web batch A, agent batch B, shared batch A. The macOS batch hit the 25 minute cap before it could summarise, but every item was implemented. Reworks: the follow loop seeded with in-progress turns and skipped them for good; perform() unscoped on success; the select-failure banner wiped by the repair switch; a Stop after the POST dropped the pointer; ctx dereferenced without the optional; botId frozen before the approval; the shared store pinned its first root; the claim takeover refused a vanished file; a narrowed type broke tsc; a new test asserted the wrong thing. |

Both models patched at the same rate; GLM's larger, riskier batches (AppModel, agent-exec)
drew more review reworks, all one hunk each. Every rework was caught by the Spark review,
the typecheck or a test, except the eve boot failure, which only the service restart found,
for the second round in a row.

## Round 2

Started 2026-09-15 late evening, finished 2026-09-16 early morning. Same slices, fresh briefs
that listed the round 1 fixes as already landed. Setup PRs before the audit: #55 (the reviewer
credential) and #56 (ORCH-02). Slice PRs: #57 web, #58 shared and scripts, #59 agent and
router, #60 macOS (plus the plant_read revert and this section), all squash-merged on
2026-09-16 after a clean Spark pass.

### Runs

| Slice | Model | Wall time | Findings | Notes |
|-------|-------|----------:|---------:|-------|
| mac-app | Spark | 2m37s | 8 | Two repeats of round 1 verdicts, one crash claim refuted live. |
| mac-app | GLM | 15m38s | 4 | Every one real: the silent save failures and the select bounce. |
| mac-core | Spark | 10m28s | 2 | A clip premise not in the code, and a round 1 repeat. |
| mac-core | GLM | 13m57s | 5 | Found the open chat never following its session. |
| web | Spark | 3m21s | 6 | Composer, dialogs and routes; all real, one partial. |
| web | GLM | 11m01s | 8 | Found the test backdoor live under next dev. |
| agent-router | Spark | 3m02s | 7 | Two by-design router findings the spec settles. |
| agent-router | GLM | 13m47s | 9 | Found the sandbox module refusing to boot with docker on PATH. |
| shared-scripts | Spark | 4m50s | 6 | Store and claim races, all real. |
| shared-scripts | GLM | 14m14s | 7 | Found the pump never rotating a retired session. |

### Findings

| ID | Model | Sev | Kind | File:line | Title | Verdict | Patch by | Patch result | PR |
|----|-------|-----|------|-----------|-------|---------|----------|--------------|----|
| S-MACAPP-01 | Spark | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:1342 | perform() failure paints saveError on whatever bot is open | confirmed | GLM | rework: the success path stayed unscoped and the bot was read inside the queued work (Spark review) | #60 |
| S-MACAPP-02 | Spark | high | ux | macos/Sources/UsefulBotApp/AppModel.swift:628 | Send silently does nothing when the selection is stale | partial: repeat of round 1 S-MACAPP-01 (ruled false); real only inside the 2.5s poll window after a server-side delete | GLM | mergeable | #60 |
| S-MACAPP-03 | Spark | medium | ux | macos/Sources/UsefulBotApp/AppSettingsView.swift:617 | Rejected budget input wipes what the owner typed | confirmed | Spark | rework: a server refusal still cleared it (Spark review) | #60 |
| S-MACAPP-04 | Spark | medium | bug | macos/Sources/UsefulBotApp/ChatDetailsPaneView.swift:571 | Rejected routine schedule edit stays on screen | confirmed | Spark | rework: the reseed could land over an in-flight write (Spark review) | #60 |
| S-MACAPP-05 | Spark | medium | ux | macos/Sources/UsefulBotApp/ChatView.swift:141 | Approval with an empty hash is a dead end | false: repeat of round 1 S-MACAPP-04, listPending always carries the hash | | | |
| S-MACAPP-06 | Spark | medium | ux | macos/Sources/UsefulBotApp/AppModel.swift:1838 | Later attachment success erases an earlier batch failure | confirmed | GLM | mergeable | #60 |
| S-MACAPP-07 | Spark | high | bug | macos/Sources/UsefulBotApp/ComposerTextView.swift:146 | Model-driven draft write can set an out-of-bounds selection | false: tested live, select-all then Send sends and the app stays up | | | |
| S-MACAPP-08 | Spark | low | ux | macos/Sources/UsefulBotApp/ProposalCardView.swift:126 | Group fanout says nobody is available next to Send to group | confirmed | Spark | mergeable | #60 |
| S-MACCORE-01 | Spark | medium | bug | macos/Sources/UsefulBotCore/EveStream.swift:412 | Optimistic user row folds only on exact equality | partial: the claimed server-side 2000 clip is in neither the proxy nor eve; deferred, not patched | | | |
| S-MACCORE-02 | Spark | low | bug | macos/Sources/UsefulBotCore/Threads.swift:67 | Mention roster capped at 64 | dup of round 1 S-MACCORE-05 (false) | | | |
| S-WEB-01 | Spark | medium | ux | web/components/chat-composer.tsx:408 | Adding files at the cap silently does nothing | confirmed | Spark | mergeable | #57 |
| S-WEB-02 | Spark | medium | bug | web/app/page.tsx:412 | Stop is dead while the first send has no session | confirmed | GLM | rework: a Stop after the POST answered dropped the pointer and kept the draft (security pass) | #57 |
| S-WEB-03 | Spark | medium | ux | web/components/app-settings-dialog.tsx:37 | Providers csrfHeaders hides an expired session | confirmed | Spark | mergeable | #57 |
| S-WEB-04 | Spark | medium | ux | web/components/marketplace-dialog.tsx:59 | Connectors csrfHeaders hides an expired session | confirmed | Spark | mergeable | #57 |
| S-WEB-05 | Spark | medium | reliability | web/app/api/usage/route.ts:36 | Usage route opens a sqlite store per request | partial: handles are released on GC, still wasteful | Spark | mergeable | #57 |
| S-WEB-06 | Spark | low | reliability | web/app/api/attachments/route.ts:15 | Attachments POST has no rate limit | confirmed | Spark | mergeable | #57 |
| S-AGENT-01 | Spark | medium | bug | agent/tools/rail_action.ts:47 | rail_action resolves names without an ambiguity check | confirmed | Spark | rework: the hint named railAction (Spark review) | #59 |
| S-AGENT-02 | Spark | low | ux | agent/tools/connector_execute.ts:41 | not_connected hint truncates multi-word toolkits | confirmed | Spark | fixed: one `toolkitHint` on both paths, resolved against the cached catalogue's 1,544 slugs | #112 |
| S-AGENT-03 | Spark | medium | reliability | agent/lib/memory.ts:146 | MemoryStore opens SQLite per call and never closes it | partial: released on GC | GLM | rework: the shared store pinned its first root (Spark review) | #59 |
| S-AGENT-04 | Spark | high | reliability | router/src/index.ts:545 | Client disconnect leaves the reservation charged | false: the spec keeps reservations on aborted requests by design | | | |
| S-AGENT-05 | Spark | high | reliability | router/src/circuit.ts:63 | One overrun disables the alias permanently | false: the spec blocks the alias on an overrun by design | | | |
| S-AGENT-06 | Spark | medium | bug | router/src/index.ts:485 | Upstream timeout before headers surfaces as 500 | confirmed | Spark | mergeable | #59 |
| S-AGENT-07 | Spark | low | data | agent/tools/memory_upsert.ts:65 | memory_upsert accepts any botId | confirmed | GLM | rework: botId frozen before the approval (Spark review) | #59 |
| S-SHARED-01 | Spark | medium | bug | shared/routines-store.ts:593 | createRoutine drops invalid schedules silently | confirmed | GLM | mergeable | #58 |
| S-SHARED-02 | Spark | medium | data | shared/agent-store.ts:528 | Unparsable expiresAt bypasses the confirm TTL | confirmed | GLM | mergeable | #58 |
| S-SHARED-03 | Spark | medium | reliability | shared/live-models.ts:105 | Concurrent refreshes lose a provider's cache entry | confirmed | GLM | mergeable | #58 |
| S-SHARED-04 | Spark | medium | reliability | shared/handoffs.ts:170 | Stale claim takeover can steal a live claim | confirmed | GLM | rework: a vanished claim was refused instead of taken (Spark review) | #58 |
| S-SHARED-05 | Spark | low | reliability | shared/workspace-store.ts:188 | sleep lacks the Atomics.wait fallback | partial: Node allows Atomics.wait on the main thread; consistency only, not patched | | | |
| S-SHARED-06 | Spark | low | data | shared/shell-store.ts:552 | createBot with kind group bypasses member validation | confirmed | GLM | rework: the new guard narrowed a type and broke tsc (orchestrator) | #58 |
| G-MACAPP-01 | GLM | medium | ux | macos/Sources/UsefulBotApp/AppModel.swift:606 | Composer setting save failures are swallowed | confirmed | GLM | mergeable | #60 |
| G-MACAPP-02 | GLM | medium | ux | macos/Sources/UsefulBotApp/AppModel.swift:1342 | saveError has no surface outside the settings pane | confirmed | GLM | mergeable | #60 |
| G-MACAPP-03 | GLM | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:432 | A swallowed select write lets the idle poll bounce back | confirmed | GLM | rework: the failure banner was wiped by the repair switch (Spark review) | #60 |
| G-MACAPP-04 | GLM | low | data | macos/Sources/UsefulBotApp/ChatDetailsPaneView.swift:326 | Routine editor commits stale text over an external edit | confirmed | Spark | mergeable | #60 |
| G-MACCORE-01 | GLM | high | bug | scripts/setup-local.mjs:121 | Every credential expires after 30 days, then a dead end | partial: the TTL is by spec; --add-missing now re-mints an expired row | Spark | mergeable | #58 |
| G-MACCORE-02 | GLM | medium | bug | scripts/service.mjs:9 | Hardcoded /usr/local/bin/node | confirmed | Spark | mergeable | #58 |
| G-MACCORE-03 | GLM | medium | bug | macos/Sources/UsefulBotApp/AppModel.swift:483 | Open-chat stream is never reconnected | confirmed | GLM | rework: seeded with in-progress turns, which it then skipped for good (Spark review) | #60 |
| G-MACCORE-04 | GLM | low | bug | macos/Sources/UsefulBotCore/ServiceSupervisor.swift:72 | isOwnNodeProcess matches a sibling checkout | confirmed | Spark | mergeable | #60 |
| G-MACCORE-05 | GLM | low | reliability | macos/Sources/UsefulBotCore/LocalServices.swift:489 | Service logs grow forever | confirmed | Spark | mergeable | #60 |
| G-WEB-01 | GLM | medium | security | web/lib/auth.ts:43 | Device-token test backdoor is live under next dev | confirmed | GLM | mergeable | #57 |
| G-WEB-02 | GLM | medium | ux | web/app/page.tsx:412 | Stop is a no-op during the first send | dup of S-WEB-02 | | | |
| G-WEB-03 | GLM | medium | ux | web/app/page.tsx:473 | Error banner stale across bot switches | confirmed | GLM | mergeable | #57 |
| G-WEB-04 | GLM | medium | data | web/app/api/memory/route.ts:12 | Memory pane truncates before the per-bot filter | confirmed | GLM | mergeable | #59 |
| G-WEB-05 | GLM | low | ux | web/lib/use-shell.ts:83 | detachError never surfaced on the web | confirmed | GLM | mergeable | #57 |
| G-WEB-06 | GLM | low | ux | web/app/page.tsx:448 | Approve or Deny fails silently when the POST throws | confirmed | GLM | mergeable | #57 |
| G-WEB-07 | GLM | low | ux | web/components/chat-composer.tsx:408 | Attaching at the cap does nothing | dup of S-WEB-01 | | | |
| G-WEB-08 | GLM | low | reliability | web/app/api/usage/route.ts:36 | Polled routes open a sqlite handle per request | dup of S-WEB-05 | | | |
| G-AGENT-01 | GLM | high | bug | agent/sandbox/sandbox.ts:6 | Docker on PATH refuses to boot the whole agent | confirmed | GLM | mergeable | #59 |
| G-AGENT-02 | GLM | medium | bug | agent/tools/bash.ts:136 | bash ignores the turn's abort signal | confirmed | GLM | rework: ctx dereferenced without the optional (Spark review) | #59 |
| G-AGENT-03 | GLM | medium | bug | agent/tools/review.ts:29 | UB_ROUTER_BASE_URL used as a full URL | confirmed | GLM | mergeable | #59 |
| G-AGENT-04 | GLM | medium | reliability | router/src/index.ts:486 | Circuit only counts failures before the first byte | confirmed | Spark | rework: success was still recorded at headers, clearing the window, and timeouts were not counted (orchestrator, Spark review) | #59 |
| G-AGENT-05 | GLM | medium | security | agent/tools/web_search.ts:27 | Search results reach the model without the untrusted envelope | confirmed | Spark | mergeable | #59 |
| G-AGENT-06 | GLM | medium | reliability | router/src/search.ts:56 | Search body read with no deadline or cap | confirmed | Spark | mergeable | #59 |
| G-AGENT-07 | GLM | low | data | agent/lib/memory.ts:268 | Expiry compared lexicographically with offsets | confirmed | GLM | mergeable | #59 |
| G-AGENT-08 | GLM | low | bug | agent/lib/memory.ts:293 | Per-bot list applies LIMIT before the filter | dup of G-WEB-04 | | | |
| G-AGENT-09 | GLM | low | ux | agent/tools/plant_read.ts:6 | S2 fixture tool registered in production | confirmed | Spark | redo: disableTool on a top-level source makes eve exit at boot; reverted in #60, still open | #59 |
| G-SHARED-01 | GLM | high | bug | web/lib/agent-exec.ts:355 | Server-driven turns never rotate a retired session | confirmed | Spark | mergeable | #58 |
| G-SHARED-02 | GLM | medium | bug | agent/tools/send_to_bot.ts:101 | Reserve released after the handoff was queued | confirmed | Spark | mergeable | #58 |
| G-SHARED-03 | GLM | medium | ux | web/app/api/providers/route.ts:79 | Saving a second key switches the active provider | confirmed | Spark | mergeable | #58 |
| G-SHARED-04 | GLM | medium | bug | shared/threads.ts:216 | stripThreadPrefix mangles a description with a blank line | confirmed | GLM | rework: its new test asserted the prefix had no blank line at all (orchestrator) | #58 |
| G-SHARED-05 | GLM | medium | bug | shared/providers.ts:282 | A settings-saved key is never used while the env key exists | confirmed | Spark | mergeable | #58 |
| G-SHARED-06 | GLM | medium | ux | web/app/api/agent/tick/route.ts:88 | Handoff delivery failures are silently dropped | confirmed | Spark | mergeable | #58 |
| G-SHARED-07 | GLM | low | data | shared/connectors-store.ts:112 | Credential store written without fsync | confirmed | GLM | mergeable | #58 |
| ORCH-03 | orchestrator | critical | data | scripts/setup-local.mjs:27 | putKeychain stored an empty value: a bare security -w prompts for the value and a retype on stdin and exits 0 on a mismatch | found while provisioning the reviewer credential | orchestrator | | #55 |
| ORCH-04 | orchestrator | medium | ux | macos/Sources/UsefulBotCore/ChatMarkdown.swift:78 | Fenced code inside a blockquote renders as loose backticks | seen in the reviewer screenshot | Spark | rework: the parser shadowed its own name and the view recursed on an opaque type (compile errors, orchestrator) | #60 |
| ORCH-05 | orchestrator | low | ux | shared/threads.ts:197 | The prefix repeats the name when the label equals it | seen in a stored routine turn | GLM | mergeable | #58 |
| ORCH-06 | orchestrator | high | ux | macos/Sources/UsefulBotApp/ComposerTextView.swift:170 | Pasting more than the draft cap leaves Send disabled | found while testing S-MACCORE-01 | Spark | mergeable | #60 |

### Verified live on 2026-09-16

- "Ask the reviewer" from the Mac app: the CEO bot called the review tool and quoted the
  reviewer's answer (#55). The router accepts the new credential for the reviewer alias and
  refuses workhorse for it.
- The rail refreshes mid-turn: a section rename made by railAction showed while the reply was
  still streaming (#56).
- A routine run carries the bot persona: the stored turn in Drive Admin's eve session begins
  with "You are Drive Admin" and its standing instructions.
- A handoff resolves the acting bot from the eve session: a routine created through a handoff
  landed on Drive Admin while CEO was the selected bot.
- /v1/search is gated: an overlapping call gets 409 session_busy, a back-to-back call 429
  search_rate_limited.
- An over-cap paste lands clipped with Send enabled (ORCH-06); a fenced block inside a quote
  renders as a code card (ORCH-04).

### Open for round 3

- G-AGENT-09: hide plant_read from live sessions without disableTool (eve refuses it on a
  top-level source). Move the fixture tool out of agent/tools or gate its registration.
- G-MACCORE-03 was not exercised live (the owner was at the machine when the check came up):
  open a bot's chat, run one of its routines from the web API, confirm the reply renders
  without re-selecting the bot.
- S-MACCORE-01: establish whether anything clips a stored turn at 2000 characters before
  changing the optimistic fold.
- Owner decision 2026-09-16: the macOS app is the priority, then the mobile app. No further
  web audits; the web surface stays as it is until the desktop and mobile apps are done.
  The CLI is out of scope.

## Round 3

Started 2026-09-17. **The roles invert this round.** Rounds 1 and 2 had Spark and GLM find
the defects and write the patches while the orchestrator verified. In round 3 the
orchestrator audits and patches, and the two models only re-review what it wrote. The
model columns below therefore mean something different from the tables above: they score
review, not discovery.

Slices: `mac-core`, `mac-app`, `agent-router`, `shared-scripts`. The web surface stays
frozen (owner decision, 2026-09-16) and the CLI is out of scope, so `web` is not a slice.
Reading was weighted toward PRs 65 to 70.

### Reviewer scorecard

| Model | Raised | Confirmed | False | Dup of the other | Precision, non-dup |
|-------|-------:|----------:|------:|-----------------:|-------------------:|
| Spark | 18 | 16 | 2 | 0 | 89% (16 of 18) |
| GLM   | 6  | 5  | 0 | 1                | 100% (5 of 5)     |

Spark ran 12 passes across the four slices, GLM 7. Two of GLM's runs and one of Spark's
hit the wall-clock cap with no output and are not counted either way.

Spark's two rejected findings are R-01 and R-02 on the mac-app pass: `unsentDrafts`
surviving New Chat and Open Recent. Rejected because the stash is deferred composer
content, and neither New Chat nor Open Recent clears the live composer (`resetThread` and
`clearPerThreadState` touch neither `draft` nor `attachments`). Dropping the stash would
be a silent loss of text the owner typed; keeping it is a visible surprise they can delete
in one keystroke. The reasoning was put back to Spark for a third pass, which timed out at
the 1500s cap with no output, so the rejection stands unchallenged rather than agreed.

The one duplicate is the widget sweep reading its keep set through `readAgentStore`: both
models found it independently on the same pass, Spark rating it critical and GLM high.

Reading the numbers: both models were most valuable on the code the orchestrator got
wrong, not on the code it got right. Every finding on the connection dedupe was real, and
two of them described defects the patch itself introduced. Neither model raised anything
on the widget sweep's own logic or on the `oneLine` prefix fix across three passes.

### The orchestrator's own audit

| Slice | Found | Patched | Deferred |
|-------|------:|--------:|---------:|
| mac-core | 3 | 1 | 2 |
| mac-app | 3 | 3 | 0 |
| agent-router | 2 | 2 | 0 |
| shared-scripts | 4 | 4 | 0 |

Plus one defect the owner reported mid-round and the orchestrator traced and fixed: the
working row flashing on a settled chat.

### Findings

| ID | Sev | File:line | Title | Verdict | PR |
|----|-----|-----------|-------|---------|----|
| O-MACCORE-01 | low | macos/Sources/UsefulBotCore/Attachments.swift:11 | Three comments assert a server-side clip that does not exist | patched, plus a test pinning the fold | #71 |
| O-MACCORE-02 | medium | shared/threads.ts:180 | A bot description with a blank line was read as breaking the stripper | **false as first stated**: PR 58 already normalizes the description. The defect is real through the NAME, title, group member and mention, which are not normalized | patched in shared-scripts |
| O-MACCORE-03 | low | macos/Sources/UsefulBotCore/EveStream.swift:573 | `turn.failed` leaves an open ask_question card up beside the failure banner | deferred: the card's buttons send the option label as a fresh message, which is a working recovery. Removing them takes an affordance away | |
| O-MACAPP-01 | high | macos/Sources/UsefulBotApp/AppModel.swift:938 | Retry resends a turn the server already accepted | patched: `SendFailure.mayResend` in core, so the rule is testable | |
| O-MACAPP-02 | high | macos/Sources/UsefulBotApp/AppModel.swift:1173 | A send that fails before delivery on a chat the owner left loses the text and then the banner | patched: `unsentDrafts` holds it for the return | |
| O-MACAPP-03 | medium | macos/Sources/UsefulBotApp/AppModel.swift:1461 | A widget save that keeps failing transiently is retried only when something else publishes, so it can stop below its cap without ever setting `widgetSaveErrors` | deferred: a real fix needs a retry schedule, and the server is loopback | |
| O-AGENT-01 | low | agent/tools/plant_read.ts:6 | G-AGENT-09, the S2 fixture tool is in the live tool set | patched as a dynamic tool returning null; **verified against a running eve**, 34 static tools with plant_read moved to `dynamicTools` | |
| O-AGENT-02 | low | agent/tools/send_to_bot.ts:129 | `sendToBot` ignores `ctx.abortSignal`, so Stop leaves a 3 minute poll running | patched | |
| O-SHARED-01 | medium | shared/widgets-store.ts:54 | `deleteWidget` has zero callers and `sweepOrphanState` never sweeps widgets | patched; **46 orphan records on this machine, zero referenced** | |
| O-SHARED-02 | medium | shared/threads.ts:205 | A newline in a name, title, group member or mention leaks the turn prefix into the transcript | patched | |
| O-SHARED-03 | medium | shared/connection-flow.ts:171 | The duplicate-URL guard is an empty if block | patched, then reworked twice under review | |
| O-SHARED-04 | high | shared/connections-store.ts:270 | `allocateConnectionId` ignores pending cards, so two cards can share an id and replacing by id repoints a live row at another URL | patched | |
| O-OWNER-01 | medium | macos/Sources/UsefulBotApp/AppModel.swift:556 | The working row flashes on a settled chat after a switch away and back | owner-reported mid-round; traced, patched in two passes, owner verified live | |

### Reviewer findings on the orchestrator's patches

| ID | Model | Sev | What | Verdict |
|----|-------|-----|------|---------|
| mac-core | GLM | low | A third copy of the false clip comment in ComposerView.swift:12 | confirmed, fixed |
| mac-core | GLM | low | The new test applies its optimistic row with `live: false` while the send path uses `live: true` | fair, applied, though GLM excluded it from its own findings array |
| mac-app | Spark | high | Retry could still duplicate: a pre-delivery failure returns its text to the composer, so the newest user row belongs to the PREVIOUS turn | confirmed, fixed |
| mac-app | Spark | medium | The kept resendable banner loops Retry forever when `resendableLastMessage` is nil | confirmed, fixed |
| mac-app | GLM | low | `restoreUnsentDraft` prepends past `Attachments.maxFiles` | confirmed, fixed |
| mac-app | Spark | medium ×2 | `unsentDrafts` survives New Chat and Open Recent | **rejected**, see the scorecard note |
| shared | GLM | high | Adopting the live row's id then writing this card's secret destroys that row's credential: `keychainSet` uses `add-generic-password -U`, so an apiKey card on an oauth row takes out its refresh token | confirmed, **the patch caused it**, reworked |
| shared | Spark + GLM | high | `completeConnectionOAuth` was never covered by the dedupe | confirmed, fixed |
| shared | Spark | high ×2 | Secrets written before the store's verdict, stranded on a race loss | confirmed, fixed |
| shared | Spark | medium | The settle path leaves the PKCE verifier and client secret on disk | confirmed, fixed, `dropOauthPending` added |
| shared | Spark | medium | The resume handoff names a connection id with no row | confirmed, fixed |
| shared | Spark | critical | The race-loss verdict was dead: `upsertConnection` returns a row found BY URL, so `stored.url != entry.url` was never true and the loser wrote over the winner | confirmed, **the patch caused it**, fixed by making the store say `won` out loud |
| shared | Spark, GLM | critical/high | The widget sweep reads its keep set through `readAgentStore`, which answers a corrupt file with an empty store, so one bad agents.json deletes every drawing | confirmed, fixed |
| shared | GLM | medium | The confirm-path settle strands a pending sign-in, reachable through Reopen | confirmed, fixed |

### Verified live

- eve boots clean with `plant_read` as a dynamic tool, and its compiled manifest lists 34
  static tools with `plant_read` beside `connection_search` under `dynamicTools`. This is
  the check that failed in round 2 and took eve down at boot.
- The widget sweep ran through the real tick: the web service picked the change up and
  removed all 46 orphan records from `~/.useful-bot/widgets`.
- `Proposal.connectRedirectAllowed` probed against 15 adversarial redirect shapes
  (userinfo smuggling, case, trailing dot, punycode, loopback, `javascript:`,
  suffix-confusion hosts). Every dangerous shape blocked.
- The working row fix, by the owner on the rebuilt app.

### Round 2 carry-overs, settled

- **G-AGENT-09**: closed. eve refuses `disableTool()` on a slot the repo owns, because
  that call removes an extension or built-in default and there is none underneath. A
  dynamic tool may resolve to `null`, which is the shape that works, and the one
  `agent/connections/registry.ts` already used.
- **S-MACCORE-01**: **false**. Nothing clips a stored turn. `Attachments.messageMax` is a
  composer input cap used only by `ComposerView.maxDraftLength` and mirrored by
  `maxLength={2000}` in `chat-composer.tsx`; there is no send route under
  `web/app/api/agent/`; the eve proxy relays untouched; the only 2000-clip in shared is on
  a proposal message field. Three comments asserted the clip as fact and are what sent
  round 2 down the trail. Pinned by a test.
- **G-MACCORE-03**: still not exercised live. Running a routine through the web API while
  its chat is open was not reached this round.

### PRs

| PR | Slice |
|----|-------|
| #71 | mac-core |
| #72 | agent-router |
| #74 | mac-app, plus the owner-reported working row |
| #75 | shared-scripts (reopened from #73 after a rebase, rather than force-pushing) |

### Open for round 4

- G-MACCORE-03, third round of asking: open a bot's chat, run one of its routines from the
  web API, confirm the reply renders without re-selecting the bot.
- O-MACAPP-03: give the widget save a real retry schedule rather than riding on whatever
  publishes next.
- O-MACCORE-03: decide whether a failed turn should drop an open question card.
- Em dashes sit in ten code comments under `macos/Sources`. Comments, not copy, and
  pre-existing, but the house rule bans them everywhere.

## Round 4

2026-09-17, same day as round 3 and the same shape: the orchestrator audits and patches,
Spark and GLM re-review. This round worked the "Open for round 4" list rather than
re-reading slices, and the first item on it turned out to be the largest defect of the
audit so far.

### G-MACCORE-03, exercised live at last: it failed

The fix from PR #60 had gone three rounds without anyone running it. The check: open the
CEO chat in the installed app, create a throwaway routine for CEO through the web API
(inactive, no schedule, "reply with this one line"), `POST /api/routines/<id>/run`, touch
nothing, screenshot every four seconds.

eve recorded the whole turn in the open session inside 3.2 seconds (`turn_12`, reply
`follow-probe ok 1458`). The app painted nothing in the 20 seconds it stayed on that chat.
The web log shows why. After the reload's replay, the next stream the app opened for that
session lasted 8.8 seconds and spanned the live turn: that was `followSession`'s seeding
read, `historyTurnIds(terminalOnly: true)`. It replayed from index 0 and stayed open until
a 3 second idle watchdog, so it saw the routine's `turn.completed` arrive live, filed that
turn under `knownTurnIds`, and the follower skipped every event of it from then on. The
turn would only appear on re-selecting the bot, which is the exact behaviour PR #60 set out
to remove.

Reading the same log turned up two performance defects nobody had reported:

| ID | Sev | File | What |
|----|-----|------|------|
| O-R4-01 | high | macos/Sources/UsefulBotApp/AppModel.swift `followSession` | G-MACCORE-03: a turn that completes during the follower's seeding read is taken for history and never rendered |
| O-R4-02 | medium | same | The follower re-read the whole session from index 0 about every six seconds for as long as a chat stayed open. On the CEO chat that is 2,311 events and 660 KB per cycle, decoded each time |
| O-R4-03 | high | macos/Sources/UsefulBotCore/BackendClient.swift `historyTurnIds` | Every send into an existing chat first took a turn id snapshot by full replay, and that read only ended on the 3 second idle watchdog. The log shows a 3.6s stream immediately before each `POST /eve/v1/session/<id>`: every message waited that long before it was even posted |

One fix covers all three. eve's `startIndex` is an absolute event count (checked: the
first event of `?startIndex=2300` carries the same `meta.id` as line 2301 of the full
read), and `includeTailIndex=1` makes eve report the last durable index in
`x-eve-stream-tail-index`.

- `BackendClient.stream` takes `startIndex`, stamps each event with its `index`, and counts
  every line that carries a payload whether or not this build can decode it, because eve
  counts those too. With `untilTail` it finishes on reaching the reported tail. The web
  proxy now relays the header.
- `historyTurnIds` reads until the tail and returns. The 3.6 second wait in front of every
  send is gone.
- `AppModel.followCursor` means "every event below this index is already in the open
  chat's projection". The reload's replay from zero sets it and the follower advances it,
  so the follower asks only for what is new and has no seeding read to race against. Turns
  a local send streamed itself are passed over by turn id. With no cursor for the live
  session (the pointer moved to a session minted elsewhere, or the load came back to a send
  in flight) the follower hands over to a reload, which starts the next follower.

Left as a follow-up, deliberately: a send still downloads the session twice, once for the
snapshot and once for its own armed stream. Neither waits on the watchdog any more, so it
is cheap on loopback, and starting the armed stream at the tail is a change to the send
path that deserves its own round.

The probe left one `follow-probe ok 1458` turn in the CEO session. The throwaway routine
was deleted.

### The rest of the list

| Item | Disposition |
|------|-------------|
| O-MACAPP-03, widget save retry | **patched.** `WidgetSaveRetry.run` in core: three attempts with waits of 1s and 4s, stops at once on a 4xx other than 429, and always returns saved, refused or gaveUp. The caller settles the widget in every outcome and shows the error for the last two. The attempt counter and its cap are gone. Loopback was the reason to defer it in round 3, and it is the reason the schedule is short, not a reason to have none: a web service restart or a held store lock is exactly the few-second failure that used to cost a drawing silently |
| O-MACCORE-03, question card on a failed turn | **settled: `session.failed` drops the card, `turn.failed` alone keeps it.** Round 3 kept the card because its buttons send the option label as a fresh message. That recovery does not survive a failed session: eve retires the session, the next send gets `409 session_not_active`, the app opens a new session (since 2026-09-23 carried over with a brief of the old one, `shared/continuation-brief.ts`), and a bare "Inbox" or "Yes" still lands there answering no live question. The Retry banner is the recovery that works. A turn that fails while its session lives on still has the question in history, so the card stays |
| Spark R-01 and R-02, `unsentDrafts` surviving New Chat and Open Recent | **rejection stands, now agreed.** Put to Spark once as a ruling rather than a review, with the reasoning and an instruction to break it. It read every entry point and found no sequence worse than a surprising draft: the stash is written only for a bot that is not selected, drained only into that same bot's composer, prepends and never sends, respects the attachment cap, and is cleared on delete |
| GLM on the final PR #74 diff | **not obtained.** A second attempt with a reading budget in the brief ran 1,191 seconds and exited 0 with no findings block at all, after the round 3 attempt died at the cap. The follower and reload code that diff touched is rewritten by this round's patch, which both models reviewed, so the gap is closed by supersession rather than by the pass that was asked for |
| Em dashes in code comments | **removed**, all ten |

### Reviewer scorecard

| Model | Passes | Raised | Confirmed | Notes |
|-------|-------:|-------:|----------:|-------|
| Spark | 3 | 0 | 0 | The ruling (61s), a clean pass on the round 4 diff (225s) and a clean pass on the fixup (123s). On the main pass it read the follower, the id dedupe and its cap, the send failure paths, the widget route and the store append before returning empty. A fourth run produced zero bytes and died at the 1,500s cap, which reads as a hung provider call; not counted |
| GLM   | 2 | 2 | 2 | One empty run on the PR #74 diff (above). Then, given only the follower and the stream reader and told to open four functions and nothing else, it finished in 933s with two real findings Spark had missed. Lesson for round 5: GLM finishes when the brief is a slice of the diff, not the diff |

### GLM's findings on the round 4 patch

| Sev | What | Verdict |
|-----|------|---------|
| medium | The send recorded its turn id for the follower to skip on the first event it yielded, so a turn whose send stream died before the terminal event (Stop, a dropped connection) was skipped to its end, terminal included: a reply that finished on the server could stay truncated until the next reload | confirmed, **the patch caused it**, fixed: the id is recorded only once the send's own stream has seen that turn end |
| low | The cursor for a session a send created was set by comparing the new id with the pre-send snapshot's pointer, which a poll can re-stamp in between | confirmed, fixed: set on what the send did (`createdSession`) |

### Found while verifying, not patched: only one bot can think at a time

During the round the owner sent CEO a message while another bot was mid-turn. It failed
after six seconds with "The last turn failed." The session shows why: three
`409 session_busy` answers from the router, then `turn.failed`.

SPEC.md:266 says one active turn per SESSION and two globally. `ConcurrencyGate` enforces
one per CALLER, and the caller is the credential. eve is one caller for every bot, and
`agent/agent.ts` stamps one process-wide `x-useful-session-id` on every model call, so the
router could not tell sessions apart even if it wanted to. The result is one model call at
a time across the whole app: talking to a second bot while the first works fails, and so
would a routine firing during a chat.

Recorded as **O-R4-04, high**, and left for the owner rather than patched at the tail of a
round, because the fix moves what the router calls a session, and the budget, duplicate
and step reservation checks all key on that. The tool side is already safe for parallel
turns: `activeBotId` resolves the acting bot from the eve session, not from process state.
Proposed shape: resolve the model per step with the eve session in hand, stamp a stable
UUID derived from that session id, key the per-caller gate on caller plus session for
completions, keep the global ceiling of two until the owner sets a number for rollout, and
have the app say "another bot is working" instead of "the last turn failed" when the code
is `session_busy` or `global_budget_exhausted`.

### Verified

- `x-eve-stream-tail-index` reaches the app's side of the proxy: `2310` for the 2,311
  event CEO session.
- 247 Swift tests (was 245) and 451 node tests pass, `npm run typecheck` is clean.
- **G-MACCORE-03, live, on the build installed from main after PR #77.** CEO chat open, a
  second throwaway routine run through the web API, no clicks: six seconds later the chat
  showed the routine note, its prompt and the reply `follow-probe ok 1612`, and the stale
  failure banner cleared. Screenshot `r4-follow-verified.png`. The web log shows the
  follower asking for `?startIndex=2326` on each cycle where it used to ask for `0`.
- Not yet observed live: the shorter wait in front of a send. No message was typed into
  the owner's chats to prove it; the next send's log line will show the snapshot read
  ending in milliseconds rather than 3.6s.

### PRs

| PR | What |
|----|------|
| #77 | the cursor follower, the send wait, the widget retry, the question card rule, em dashes |

### Open for round 5

- O-R4-04, the router gate (above). The one that matters for rollout.

- The send path's two full reads per message (above).
- `performReload` returns before starting a follower when a send begins mid-replay, so
  that chat is not followed until it is re-selected. Predates this round; rare.
- `tsc -p web` (not the project's configured typecheck) reports one error in the frozen
  web UI, `web/app/page.tsx:550`, a `widget` event kind missing from `ThreadRow`.

## Round 5: ten bots at once (O-R4-04)

One finding, carried from round 4, fixed on `feat/ten-bots-in-parallel`.

### What was wrong, and what changed

| Where | Before | Now |
|-------|--------|-----|
| `agent/agent.ts` | one random session and turn id per PROCESS on every model call | ids derived from the eve session and turn by a stable hash, one model handle per session (`agent/lib/router-identity.ts`, `session-model.ts`); `UB_SESSION_ID` and `UB_TURN_ID` still pin them |
| `router/src/concurrency.ts` | one active per caller (the credential), two globally | one active per caller plus session, ten globally |
| the ceiling's code | `global_budget_exhausted`, which is also the DAILY aggregate budget, so the app said the day's tokens were gone | its own code, `global_concurrency_limit`, retryable, with `Retry-After` |
| `/v1/search` | took the same per-caller gate as completions | its own gate of four; never holds or waits for a completion slot |
| `Retry-After` | never sent; only `retry_after_ms` in the body | sent on every error that knows its wait; `caller_rate_limit` and the one-a-second search limit now say how long |
| the agent on a full house | three attempts in six seconds, then `turn.failed` | the fetch waits out `global_concurrency_limit` and `caller_rate_limit` for up to 60s per attempt; never a budget code, never `session_busy` |
| the app's wording | `session_busy` fell through to "The last turn failed." | "This bot is still working on its last step." and "Ten bots are already working. Try again in a moment." |
| reviewer subagent, `review`, `web_search` | process-wide ids, or none | the calling bot's session |

Decided and kept: the alias circuit breaker stays per alias, shared by every session.
What it counts are faults of the one provider account, so one bot's provider 429 rightly
backs every bot off. Duplicate detection keys on caller plus request id and every attempt
carries a fresh id, so it needed no change. Reservation and settle run inside
`BEGIN IMMEDIATE`, so ten parallel requests serialize there and cannot overspend a budget.

### Hidden single-file points

| Where | Verdict |
|-------|---------|
| handoff pump and routine scheduler (`web/lib/agent-exec.ts`) | **were single file**, by design for the old router: one delivery at a time, so a two minute turn on one bot held up a handoff to another. Each pump now runs its batch together, one delivery per receiving bot, still bounded by the tick's limit of four |
| pump state across API routes | **broken, found live**: the Next dev server gives each route its own copy of the module, so a Test run marked its routine in a set the tick never saw. Five routines ran and the tick reported none. The in-memory mutex between a manual run and the scheduler did not hold across the two routes either; only the durable store claim guarded it. State now lives once per process |
| rail working state for routines | **missing**: the tick reported working bots from handoffs only. It now includes bots whose routine is running |
| web proxy in front of eve | stateless per request, no shared session or stream variable. No change |
| `agents.json` and the six stores with the same lock | every critical section is synchronous, so bots inside one process never contend; only the eve and web processes do, for milliseconds. A 3s stale steal needs a 3s synchronous hold. No change |
| the app's `sendTasks` and working set | per bot throughout; the rail holds a set. No change |

Left open: a pump call still waits for the slowest delivery of the batch before it (up to
120s) before the next batch starts. A manual Test run and a scheduled routine on the SAME
bot can still overlap, and eve refuses the second turn; predates this round.

### Reviewer scorecard

| Model | Passes | Raised | Confirmed | Notes |
|-------|-------:|-------:|----------:|-------|
| Spark | 3 | 0 | 0 | Pass 1 returned an empty array after narrating "Tool context handling flagged" and "Spec language conflicts with the new retry behavior", with three ripgrep errors. **Not counted as clean.** Both items were chased by hand: the two tools read `ctx.session.id` unguarded where every other tool reads it defensively (fixed), and the spec said 409 has "no automatic replay" while the AI SDK does retry one (spec made precise). Pass 2, told to list what it dismissed, checked twenty items with reasons and raised none (274s). Pass 3, on the pump state commit alone, dismissed four with reasons, the hot reload strand among them (56s). Lesson: ask for a DISMISSED list, an empty array alone proves nothing |

### Verified

- 466 node tests, 254 Swift tests, `npm run typecheck` clean.
- Gate tests in `router/test/contracts.test.ts`: a busy session is 409, ten sessions of one
  caller run together, the eleventh is a retryable 429 with `Retry-After: 2`, the slot comes
  back after an upstream 500 and after a client disconnect, a search runs while the same
  session holds a completion.
- **Live, after restarting the router and eve on this branch.** Five throwaway probe bots,
  each a fresh eve session, none of the owner's chats touched: four turns fired together
  and a fifth routine three seconds later, four rounds, twenty turns. All `ok`. Zero 4xx in
  the router log since the restart, so no `session_busy`. Usage before 353 requests, after
  373: one model call per turn. Probes and their routines deleted, selection restored.
- The rail: all five probe avatars change from frame to frame across four screenshots while
  the three idle bots are byte-identical in all four (`review-tenbots-rail.png`). The
  working state is an animated avatar, so one still shows it weakly.
- eve 0.54.3 boots with a dynamic model on the reviewer subagent. The reviewer credential is
  still unprovisioned on this Mac, so that path is not exercised live.
