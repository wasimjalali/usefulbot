# UB-002 live check: per-bot models, frozen turns, cache hits (2026-10-01)

## Question
Does a bot keep its own model while another bot runs a different one? Does a turn stay on the
model it started with when the owner switches mid-turn? What do the provider's cache counters
say once the router logs them?

## What ran
- Useful Bot Dev, built from `feat/ub002-model-switching` (2026-10-01 17:07 CEST), OpenCode Go
  plan connection.
- Two bots: "Test Bot" and "Test Bot 2". Test Bot 2 was created by asking Test Bot for it, then
  "Add teammate".
- Driven with cua-driver in the background (no pointer, no focus).
- Data: the router's new `upstream_usage` line. The first build wrote one per completed upstream
  call; since review round 1 it writes one per dispatched call, with an `outcome` field. Raw lines are in
  `2026-10-01-ub002-model-switching-usage.jsonl` (29 calls, 15:09 to 15:17 UTC).
- Screenshots beside this file: `2026-10-01-ub002-running-model.png` and
  `2026-10-01-ub002-overlap.png`.
- Extraction and summary: `2026-10-01-ub002-extract.py` (usage in its docstring; the jsonl was
  cut from `~/Library/Logs/UsefulBotDev/service-router.log` for 15:09 to 15:18 UTC).
- Cost: OpenCode Go subscription, no per-call charge. 404,194 input tokens (317,824 cached) and
  1,031 output tokens in total.

## Scenarios and results

| # | Scenario | Expected | Observed |
|---|---|---|---|
| 1 | Pick DeepSeek V4 Flash on Test Bot 2 | Only Test Bot 2 changes | `shell.json`: Test Bot 2 `deepseek-v4-flash`, Test Bot still `glm-5.3-flash` |
| 2 | Upgrade with bots that had no model | No bot follows a pick made on another bot | This run used the first build, which pinned all seven bots at the first turn. Review round 1 changed the rule (see below); the shipped rule is unit-tested |
| 3 | Test Bot runs 6 tool calls on GLM 5.3 Flash; mid-turn its chip moves to Kimi K3 | All 7 calls of that turn stay on GLM; working row shows the running model | 7/7 calls `glm-5.3-flash` (15:14:34 to 15:14:57). Working row read "Thinking · GLM 5.3 Flash" while the chip showed "Kimi K3 Low" |
| 4 | Test Bot's next turn | Kimi K3 | 5/5 calls `kimi-k3` (15:16:11 to 15:16:18) |
| 5 | Test Bot 2's first turn in a brand-new session | DeepSeek from the first step (stamp wait) | 3/3 calls `deepseek-v4-flash`, first call included |
| 6 | Overlap: Test Bot (Kimi K3, `sleep 25` between tools) while Test Bot 2 (DeepSeek) runs 3 tools | Each bot on its own model during the overlap | Test Bot's turn ran 15:17:06 to 15:17:37 on `kimi-k3`. Test Bot 2's full turn (15:17:20 to 15:17:24) ran inside it on `deepseek-v4-flash` |

## Cache and latency (OpenCode Go, per model)
Time to first byte (TTFB) is the median time from dispatch to the first upstream byte.

| Model | Calls | Calls with 0 cached | Median TTFB, 0 cached | Median TTFB, cached | Share of input cached |
|---|---|---|---|---|---|
| deepseek-v4-flash | 12 | 0 (1 not reported) | n/a | 740 ms | 90.5% |
| kimi-k3 | 8 | 1 | 2,102 ms | 1,397 ms | 85.8% |
| glm-5.3-flash | 9 | 3 | 722 ms | 512 ms | 55.3% |

- Test Bot's switch from GLM 5.3 Flash to Kimi K3 is the one model switch in this run. Its first
  Kimi call read 0 cached tokens and every later call hit, which fits caches being per model. One
  switch is not enough to call that a rule. DeepSeek's first call in its new session reported no
  cache field at all (null), which is not the same as a miss.
- GLM 5.3 Flash's three misses: the session's first call (15:09:33), the first call after five
  idle minutes (15:14:34), and one call in the middle of a turn (15:14:39) with the same session
  header. That last one is the provider's routing, not something this build controls.
- **Not a before/after comparison.** OpenCode Go was already caching before this change, because
  the router has sent an `x-opencode-session` header since PR #3, per bot since PR #83. This PR scopes that
  header by connection and model, and makes the counters visible. A cached call's TTFB is lower
  here, but the calls with 0 cached are few (1 to 3 per model), so treat the latency numbers as
  indicative.

## Not covered live
- **Anthropic and OpenAI caching** (`cache_control`, `prompt_cache_key`): no such connection in
  the dev app. Covered by unit tests only.
- **Compaction after a switch to a smaller window:** not triggered (chats stayed near 15k tokens).
  Covered by unit tests and the agent's compaction log hook.
- **The "unavailable model" chip state:** unit-tested only.

## What changed because of it
- Review round 1 (GPT-6.1-Sol and Sonnet 5.5) changed the pinning rule. A bot with no model of its
  own now inherits the default, which is what the old global chip resolved to. Bots are pinned only
  just before a per-bot pick moves the default. Removing a connection resets the bots pinned to it to
  "inherit". Pinning every bot at connect, sign-out and turn start had stranded a fresh install's
  default bot on an unconnected provider.
- After the round 1 fixes, a sanity turn on Test Bot 2 stayed on `deepseek-v4-flash`. Both calls
  logged `outcome: "ok"`, and the eve log has no `turn_stamp_missing` line. Raw lines:
  `2026-10-01-ub002-round1-sanity-usage.jsonl`. The first call's 26.9 s TTFB is measured from the
  router's dispatch, so the wait was upstream.

- Re-run on the round 3 build (commit 4343a5c), whose freeze reads the owning bot's current
  selection first. Test Bot was on Kimi K3. It ran `sleep 20` and then `date -u`, and during the
  sleep its chip moved to GLM 5.3 Flash. All 3 calls of that turn stayed on `kimi-k3` (16:24:38 to
  16:25:03 UTC). The next turn ran on `glm-5.3-flash`. Neither turn logged `turn_stamp_missing`.
  Raw lines: `2026-10-01-ub002-final-midturn-usage.jsonl`.

## Conclusion
- Per-bot selection, next-turn switching and concurrent bots on different models work live on
  OpenCode Go.
- Cache counters are now logged per call. Nothing in this run shows a cache regression from
  scoping the session header per model.
