[0m
> build · muse-spark-1.3-contributor
[0m
Adversarial review underway. Reading the plan and catalog to stress-test every claim.
[0m→ [0mRead .
[0m→ [0mRead docs/plan/PLAN-v0.1.md
[0m→ [0mRead docs/research/codex-model-catalog.json
## Verdict
Unsound, because the stateless OpenAI proxy cannot faithfully carry Codex app-server sessions and eve tool calls.

## Critical
- [Sec 3, D3, 1.4] Codex app-server is stateful (threads, turns, approvals, execution review) but router exposes `POST /v1/chat/completions` stateless. Mapping breaks on multi-turn tool loops, thread leak on retry, approval callbacks with no HTTP equivalent. Fix: spike S4 must prove thread reuse across 3 turns plus a tool call plus cancel, or drop Codex from v1 router and call it as a separate eve tool.
- [Sec 3, 1.1, 1.3] Tool call passthrough will break. eve via `createOpenAICompatible(...).chatModel(id)` sends AI SDK tool schemas, expects strict `tool_calls` with stable ids, streaming deltas, stop reasons. Router re-emitting OpenCode Go and Codex shapes will corrupt ids, parallel calls, `reasoning_content`. Fix: contract test per adapter using real traces from `eve traces`, fail boot if shape drifts.
- [Sec 3 Secret discipline] Router bearer equals credential. `agent.ts` holds it in env, eve `bash` tool can `env`, `cat`, `curl 127.0.0.1:4319`. Any prompt injection exfiltrates full model access. Fix: scrub env for agent process, store router token in sandbox deny list, require approval gate on `bash` + `web_fetch` to loopback, document in `agent/sandbox/sandbox.ts`.
- [Sec 3, 3.3] Tailnet exposure has no auth design. `localDev()` plus bearer in `agent/channels/eve.ts` leaves Next.js `agent/channels/web/` auth undefined, TLS undefined, phone identity undefined. Unauthenticated host on tailnet can drive `/eve/v1/stream` and run tools. Fix: specify Tailscale whois check or Tailscale Serve with funnel off, short lived tokens, no `placeholderAuth()` in any build.

## High
- [D2] D2 is vacuous. It says hybrid with proven translators but names none, while D3 and D4 mandate hand built adapters. Pick one: own thin router or named fork, with owner for OAuth refresh and streaming fixes.
- [D5, S6] Subagent pin plus step-level selection together breaks cache and accounting. Step handler swapping model id behind one alias defeats `modelContextWindowTokens`, compaction thresholds, prompt caching. Fix: pin per subagent only for v1, defer step handler to S6 optional.
- [Sec 2, 1.7] Context windows are load bearing and unknown. eve cannot look them up, router hides real id, so compaction and truncation use wrong numbers and large sessions fail late. Fix: registry must store sourced window per upstream id, `agent.ts` must set conservative min until 1.7 passes.
- [S1, S5] Spikes are unsafe as written. `npx eve@latest init .` in a non empty repo with `docs/` and `scripts/` risks overwrite, microsandbox on M1 without Docker is unverified and may fall back to `just-bash` with full filesystem. Fix: spike in temp dir, S5 must assert backend name from trace and deny write outside `/workspace`.
- [2.5] Custom `web_search` has no provider, key, cost or filter spec. Built in `web_search` only appears for supported providers, so v1 ships blind if router looks generic. Fix: choose one (Exa, Tavily, Brave), add key to `scripts/install-keys.sh`, rate limit in `agent/tools/web_search.ts`.
- [Phases] Build order violates fixed priorities. macOS app first is required, plan builds web UI then defers `macos/` to Phase 5, with TUI via `eve dev` unspecified. Fix: Phase 3 must deliver WKWebView shell against local URL before design polish.

## Answers to the plan's open questions (its section 8)
1. One router process for v1. Three services triples auth, ports, supervision and failure modes with no isolation gain on a single user M1. Split only if Codex stdio instability forces process isolation.
2. Neither survives as a completion endpoint without work. `app-server` preserves session semantics if you keep thread ids in router state, `codex exec` per turn loses threading, approvals and compact state and forks cost on every tool step. Use `app-server` with pinned thread per eve session, explicit close on `clear` or `reset`.
3. Markdown files under `~/.useful-bot/memory/` plus SQLite index, not `defineState` alone. `defineState` is session scoped per plan Sec 2, lost across sessions. At 10k files full scan, concurrent write torn files, and unbounded context injection break retrieval. Need write lock, dedup, summarizer.
4. Pin per subagent. Step level switching churns provider connections, kills prompt caches, hides cost per task. Caches stay warm only when same model and similar prefix repeat, which subagent pinning gives.
5. Smallest v1: S2 plus S3 plus locked Codex tool path, `agent.ts` on one OpenCode Go workhorse, web chat on loopback with real auth, memory read and write, microsandbox gate, one eval run. Defer schedules, MCP GitHub write, CLI bridges, design pass, macOS shell.
6. What is wrong in section 5: D2 promises translators without naming them. D3 overclaims sanctioned status for proxying a ChatGPT subscription through a local API. D5 picks two routing mechanisms at once. D8 rejects eve primitives without a concurrency story. D9 assumes microsandbox works on this M1 without proof.

## What the plan is missing entirely
- Supervision and lifecycle. Two processes (`eve dev` plus `127.0.0.1:4319`), no launchd units, no health check, no restart on sleep wake, no log redaction, no quota and 429 surfacing from `GET /v1/models`, no backup for memory and schedules. Consequence: first laptop sleep or upstream rate limit leaves phone UI hanging with a durable turn that never resumes.
- Observability contract: which `eve traces` fields prove model id, tokens, tool latency per upstream, where reasoning is stored, retention on disk.

## The one change that most improves this plan
- Make S4 a full session fidelity spike before any router code: 3 turn conversation with one tool call, cancel mid stream, restart router, show same Codex thread resumes and `~/.codex/auth.json` untouched. If it fails, Codex leaves the completion path and becomes an explicit agent tool. This removes the largest unknown (stateful to stateless mapping) that all of Phase 1 depends on.
