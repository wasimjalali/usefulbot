# UB-002: model switching, context and per-bot isolation (current state)

**Status:** the defects below are fixed on `feat/ub002-model-switching`. Live results are in
`evals/results/2026-10-01-ub002-model-switching.md`. The rest of this file describes `main`
before that change.

Audited 2026-10-01 on `main` at 1700c45, read only. Two Sonnet 5.5 sweeps traced the code; Opus
re-read the load-bearing paths (`shared/providers.ts:138-148, 1069-1137`,
`router/src/upstreams/opencode.ts:120-170`, `router/src/circuit.ts`, `agent/agent.ts`). eve is
0.54.3 (`node_modules/eve/dist`, minified, cited by file and function). Nothing here was measured
live; live numbers come with the fix.

## Part B: are bots isolated?

**No. The model choice is one global setting.**

- The only selection state is `ProviderStore.activeConnectionId`, `selectedModel`, `effort` and
  `speed` (`shared/providers.ts:138-148`), one `providers.json`. `ShellBot`, routines and handoffs
  carry no model field (`shared/shell-store.ts:48-95`, `shared/routines-store.ts:63-90`).
- The composer chip writes it with `PUT /api/providers` and no bot id
  (`BackendClient.swift:1742-1751`, `web/app/api/providers/route.ts:136-165`). Every bot's chip
  shows the same value.
- A send carries no model (`BackendClient.swift:1379-1382`). The agent always asks for the alias
  `workhorse` (`agent/agent.ts:160`).
- The router re-reads the store **on every HTTP request** (`opencode.ts:127`) and resolves
  connection, model, credential, effort and speed there.
- Consequences:
  - Bot A and bot B can never run different models at the same time.
  - Picking a model for bot B moves bot A's running turn to it at A's next step.
  - `setComposer` re-snaps effort to what the new model supports (`providers.ts:1119-1137`), so
    B's pick can change A's effort too.
  - Routines and handoff deliveries use whatever is selected when they run, not when they were
    set up.
  - After a restart every bot gets the one stored selection.
- What is already isolated, and correct:
  - Concurrency: one in-flight call per bot session, ten in total (`router/src/concurrency.ts`).
  - Model handles: one per eve session (`agent/lib/session-model.ts`).
  - The opencode session header is per bot (`opencode.ts:200-202`).
  - Permissions: per bot, stamped onto the session at turn start (`web/lib/agent-exec.ts:83-92`).
    That is the pattern the fix reuses.
- **Shared state that crosses bots and models: the router circuit.** It is keyed by alias only
  (`router/src/circuit.ts`).
  - A provider rate limit pauses every bot, on every model, for up to 300 s.
  - A missing model pauses everything for 300 s.
  - Three refusals in 60 s pause everything for 30 s. A 4xx refusal (context overflow, bad tool
    id, tools unsupported) is mapped to `upstream_protocol_error` and counts
    (`opencode.ts:256`).
  - Switching model doesn't clear any of these.
  - A spend-guard overrun disables `workhorse` for every bot until the router restarts.

## A running turn is not immutable

- eve picks the model on every `step.started` (`agent/agent.ts:178-186`). `currentWindowTokens()`
  re-reads the store there, then the router reads it again per request.
- A switch mid-turn therefore moves the rest of that turn, including tool continuations, to the
  new model.
- The two reads can disagree. A switch between `step.started` and the request, or during a 429
  wait of up to 180 s (`agent/lib/router-fetch.ts:20-25`), sends a prompt sized for model X to
  model Y.
- eve retries failed calls up to 3 times, and each retry re-resolves. One step can span models.

## Part A: what a switch does to the chat

| Mechanism | Today |
|---|---|
| History | The full eve session is replayed to the new model as is. There's no per-model copy and no adapter beyond what each upstream does. |
| Reasoning | Stored with the turn and sent back as `reasoning_content` to every openai-chat model, whoever wrote it. Inline-think models get it re-wrapped as `<think>`. Responses and Anthropic drop it. Encrypted reasoning is requested on ChatGPT and then thrown away. |
| Tool calls | Ids pass through unchanged. Anthropic's id pattern and its empty-assistant-turn rule are unchecked (INFERRED 400 risk after a switch). |
| Images | Replaced by a text note for models the catalog marks text-only (`opencode.ts:44-65`). A new image send to a text-only model is refused with `model_no_vision`. |
| Window | Read from the catalog per step. An unknown window (custom, Ollama, LM Studio, unlisted) silently becomes 131,072 (`agent/lib/model-window.ts:20-22`). |
| Compaction | eve sets the threshold to 75% of the step's window before the call. A switch to a smaller window compacts on the first step. The estimate counts messages only, not the system prompt or tool schemas. The summary is written by the newly selected model and **replaces** the history permanently. The app shows a transient "Compacting the conversation" row. Nothing records why, when, which model or how many tokens. |
| Continuation brief | Not a switch mechanism. It only runs when a session is retired (409) or its history breaks. |
| Provider sessions | None. Responses calls use `store:false` with no `previous_response_id`. |
| Prompt caching | None of ours: no `cache_control`, `prompt_cache_key` or cached-token parsing (zero grep hits). eve adds Anthropic cache markers only for a provider named "anthropic", and ours is `useful-bot-router`. Any automatic provider-side caching is unmeasured: UNKNOWN. |
| Effort | Global. It's snapped to the model's levels and mapped per protocol (`shared/models.ts:405-449`). Levels are mostly guessed from the model name. A model with no levels sends nothing, silently. A round trip through a model without the level loses it. |
| Attribution | No message records which model answered. `x-useful-upstream-model` is set by the router and read by nobody. |

## Failure handling

- Silent substitution:
  - A selected model that drops out of the live list becomes the list's first model, in both the
    chip and the router (`shared/models.ts:358-391`). Nothing says so.
  - The agent's window lookup has the same fallback without the router's `option.id === model`
    guard.
- Vague errors: `model_unavailable`, `upstream_auth_failed`, `provider_disconnected` and
  `upstream_credential_missing` all reach the owner as "The turn failed."
  (`macos/Sources/UsefulBotCore/EveStream.swift:299-390`).
- The reviewer sub-agent hardcodes a 131,072 window (`agent/subagents/reviewer/agent.ts:68`).

## Defects, ranked

| # | Severity | Defect |
|---|---|---|
| 1 | High | Selection is global: no per-bot model, effort or connection. A pick in one chat moves every bot, including running turns, routines and handoffs. |
| 2 | High | A running turn isn't frozen. Its remaining steps follow the latest pick, and the window and model reads can disagree within a step. |
| 3 | High | The circuit is per alias. One model's rate limit, missing model or repeated refusals block every bot on every model, and survive a switch. |
| 4 | Medium | Unknown windows default to 131k, so a small local model overflows before eve compacts. |
| 5 | Medium | Compaction after a switch is permanent, invisible and unlogged. The estimate leaves out the system prompt and tools. |
| 6 | Medium | Cross-provider history: reasoning written by one model is replayed to another, and Anthropic id and empty-turn rules are unchecked. |
| 7 | Medium | A model that disappears from the list is silently replaced by another. |
| 8 | Medium | No prompt caching and no cache metrics on any path. |
| 9 | Low | Router failure codes show as "The turn failed." No record of which model answered. Stale `/v1/models` listing and a stale 90% comment (`shared/policy.ts:89`). |
| 10 | Low | No tests for the circuit, the gate, a mid-turn switch, or which model a routine or handoff uses. |
