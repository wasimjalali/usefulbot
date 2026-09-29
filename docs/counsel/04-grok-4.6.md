[0m
> build · grok-4.6
[0m
[0m→ [0mRead docs/plan/PLAN-v0.1.md
[0m→ [0mRead docs/research/codex-model-catalog.json[90m [limit=100][0m
I'll read the plan and catalog first, then do an adversarial review against what is actually specified.
[0m✱ [0mGlob "docs/research/**"[90m 1 match[0m
[0m✱ [0mGlob "**/*.{md,json,ts}"[90m 7 matches[0m
[0m% [0mWebFetch https://eve.dev/docs/sandbox
[0m% [0mWebFetch https://eve.dev/docs/agent-config
[0m✱ [0mGrep "app-server|codex exec|stdio"[90m in docs · 25 matches[0m
A few claims in the plan look load-bearing. I'll check eve docs and the local catalog before calling them.
[0m→ [0mRead docs/research/codex-model-catalog.json[90m [offset=1, limit=1][0m
## Verdict
Unsound: Codex app-server is a second agent, not an OpenAI model, and the plan gates v1 on pretending otherwise.

## Critical
- [§3, D3, S4, 1.4] The router exposes `POST /v1/chat/completions`. Codex app-server is JSON-RPC (threads, approvals, `shell_type: unified_exec` in `docs/research/codex-model-catalog.json`). Eve already owns tools, compaction, and durable history. Mapping those together fails on: tool schemas that Codex will try to execute itself, compacted eve history replayed into a live Codex thread, cancel with no HTTP equivalent, and retry that leaks threads. S4 only requires one text reply, so it will "pass" and bake the lie into 1.4. Fix: either (a) drop Codex from the router for v1 and call it as an eve tool, or (b) rewrite S4/1.4 as a stateless completion: one fresh thread per request, full eve message list, tool-call round trip, streaming, cancel. D3 is inverted: you do not want Codex session reuse. Eve is the session.

## High
- [D5, S6, R6] Three selectors (subagents, `step.started`, router fallback) on one turn. Eve docs: prompt caches are per model, prefer `session.started`, every switch re-ingests uncached. Router fallback mid-stream also desyncs `modelContextWindowTokens` (compaction uses eve's number, not the upstream's). Fix: pin one default alias on the root agent, pin models on subagents, fallback only at `turn.started`. Kill S6's "or".
- [§6 Phase 2] 2.3–2.10 is a Hermes clone (6 skills, memory, search, 3 subagents, MCP, cron, 4 CLI bridges) before the primary surface exists. Hermes will still win. Cut to chat + memory + sandbox + OpenCode Go.
- [§3, 3.3, 5.1] Router on `127.0.0.1:4319` is right. Eve/Next bind address is unspecified. Phone-over-Tailscale needs the channel on the tailnet IP with a bearer; `localDev()` will not do that. No launchd for router + eve + Next + `codex app-server`. Sleep/wake in 5.1 tests the WKWebView, not the Node processes. Failure mode: app opens to a dead origin.
- [2.5] `web_search.ts` has no upstream. "Live query returns real results" is undefined without Exa/Brave/etc and a key path that is not `router/.env` leaking into eve's app runtime (authored tools see `process.env`).
- [D7, 4.2] Constraint is macOS first. Replacement trial runs for two weeks before Phase 5, in the browser/TUI. Either move a thin WKWebView to right after 3.1, or admit v1 is web/TUI.

## Answers to the plan's open questions (its section 8)
1. One router process. Extra services add ports, tokens, and launchd units with no isolation win on one M1 user. Split later only if Codex stdio crash-loops.
2. `codex app-server` as a long-lived child, consumed statelessly (new thread per `/v1/chat/completions`, full history). `codex exec` per turn is worse parsing and still not a model API. ChatGPT "session semantics" must not be mirrored; eve already checkpoints. If S4 cannot return eve-shaped `tool_calls` without Codex running a shell, Codex is a tool, not an upstream.
3. Markdown under `~/.useful-bot/memory/` plus a small recency/keyword index. `defineState` is session-scoped, so it cannot be the store. At 10k files, disk is fine; the break is dumping them into the prompt and fighting compaction. Cap retrieval (N, recency). SQLite when the index is slow, not on day one.
4. Pin per subagent. Step-level switching cold-starts caches every step (eve's own warning). Router aliases as eve model ids, each with its own `modelContextWindowTokens`.
5. S1–S3, S5, 1.1–1.3, 1.6–1.7, 2.1, 2.2, 2.4, 3.1, 3.3, a launchd plist, then a WKWebView load of that chat. Default model: one OpenCode Go workhorse. No Codex adapter, no subagents, no MCP, no cron, no CLI bridges, no design pass.
6. D3 (session reuse is the bug). D5 (two mechanisms). D2 names no translator. D7 fights the macOS-first constraint. D9 is directionally right but understates that `microsandbox()` still pulls `ghcr.io/vercel/eve` and that `eve start` will not auto-install the VM the way `eve dev` does.

## What the plan is missing entirely
- Process supervision (launchd, crash restart, ordered shutdown). Consequence: the product is down after a reboot or sleep.
- A Codex mapping spec (RPC methods, thread lifecycle, how eve tools become `tool_calls`). Consequence: 1.4 is unbounded.
- Memory injection budget. Consequence: windows fill, compaction fights the memory tool.
- Channel bind/CORS/WKWebView token injection. Consequence: tailnet and the Mac app cannot auth.
- Default sandbox egress is `allow-all`; 2.7 never picks a policy. Consequence: the agent can exfiltrate from `/workspace`.

## The one change that most improves this plan
Make OpenCode Go the only v1 `LanguageModel`. Treat Codex as a later spike whose pass condition is a full tool-call round trip, or as an eve tool, not as `/v1/chat/completions`. That removes the false abstraction, lets S3/1.3 ship a working agent, and stops Phase 1 from stalling on a protocol translator.
