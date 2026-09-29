# Perf regression guard: design consult with GPT-6-Astra, 2026-09-26

## Question

Ten batches of performance work (see `docs/audit/PERFORMANCE.md`) took first chat opens from
4.4-6.3 s to under half a second and cold landings from 10 s to 0.6 s. Nothing guarded those
numbers. Before building a guard that fails a change when they slip, was the design sound,
and how should it measure?

## What ran

- Model: GPT-6-Astra in Codex CLI 0.154.0, `model_reasoning_effort="xhigh"`, read-only sandbox.
- Command: `codex exec -m gpt-6-astra -c model_reasoning_effort="xhigh" -s read-only --skip-git-repo-check -o astra-verdict.md - < astra-brief.md`
- Input: `2026-09-26-perf-guard-design-consult/astra-brief.md`. It read ChatView, AppModel and
  PERFORMANCE.md excerpts. Output: `astra-verdict.md` beside it.
- Cost: 72.8k tokens on the Codex subscription, no metered spend. About 4 minutes.

## Verdict

It approved the structure (separate skill, per-repo `perf/` folder, median plus worst-run
budgets, local runs, results in `evals/`) and changed the measurement contract.

| Astra's point | What changed in the build |
|---|---|
| `landedBotId` asks for visibility, it doesn't prove pixels are on screen | The judged number is select to the last frame the chat column changed. The app's landing mark is kept as a second number |
| Start inside `select`, before the stash | `select_start` is marked before `stashCurrentThread()` |
| Landing can end on the 10 s cap and still look like success | Every landing mark carries its reason (`settled`, `cap`, `no_geometry`, `sent`) and anything but settled or sent fails the case |
| Record from before the select, not after landing | Frames are recorded for the whole launch |
| Check responsiveness after landing | The app samples the main thread for 1 s after each landing (`stallMaxMs`) |
| Distributed notifications can be delayed or dropped | No notifications: a launch-argument-gated sequencer inside the app runs the scenario |
| Don't rely on `log show` | The app writes JSON lines with `CLOCK_UPTIME_RAW` times to the runner's file |
| 30 fps can't resolve small regressions | The recorder runs at 60 fps and stamps each frame with its presentation time |
| Use a frozen fixture, not the owner's growing chats | Four "Perf ..." bots built once and locked by session id and event count. Cloning an eve session was rejected (compressed beta-format internals) |
| Five runs catch a 10% intermittent slowdown 41% of the time | 5 cold launches per case, 10 warm short switches, 30 returns to each long chat |
| Cache state decides the path | Cases are split by path (disk snapshot, no snapshot, warm cache) and a sample on the wrong path fails |
| Preflight power, thermal, memory, web mode | The runner refuses a locked screen, Low Power Mode, a thermal limit or a web service not on a fresh production build, and records the rest |
| Baseline is not the budget, and audits propose, never overwrite | `baseline` writes `budgets.proposed.json`; `budgets.json` only changes by a reviewed edit |

Not taken: separate "service-cold" cases. The services outlive the app, so every cold case is
app-cold with warm services, and the write-up says so.

## What changed because of it

The guard was built to the revised contract: `perf/` in this repo and the
`perf-regression-guard` skill.
