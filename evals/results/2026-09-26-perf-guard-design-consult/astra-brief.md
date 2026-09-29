# Consultation: design review of a performance regression guard (read-only)

You are a consultant. Read code, do not edit anything, do not run the app. Reply with a verdict on the
design below plus concrete changes. Be specific and short. Target: under 1,200 words.

## Context

Repo: Useful Bot, a native macOS SwiftUI app (`macos/Sources/UsefulBotApp`) talking to a local Next.js
web service and an eve agent runtime (chat sessions live in eve, replayed on open; see
`docs/audit/PERFORMANCE.md` for 10+ batches of perf work and how each was measured).

Hard-won gains we want to guard:
- First open of a chat: 4.4-6.3 s -> 0.06-0.47 s (chat snapshots + cursor resume, batch 10).
- Warm switch back: 0.69-0.95 s -> 0.36-0.42 s.
- Cold landing: 10,037 ms -> 592 ms (PR #136).
- Idle CPU 29% -> 1%, memory 268 -> 121 MB.

The owner reports that switching to a bot with a very long chat is still slow *sometimes*, even warm.

## Proposed design

1. A new global skill `perf-regression-guard` (generic method + scripts), separate from the existing
   `multi-model-perf-audit` skill, which stays untouched except one line: after an audit, record the new
   numbers as budgets.
2. Per repo, a committed `perf/` folder: `config.json` (app path, window, cases) and `budgets.json`
   (per case: median budget and worst-run budget), plus `npm run perf:check` which exits non-zero on breach.
3. Cases (each run 5 times; judge median AND worst run so intermittent slowness fails):
   1. Cold start: launch until the first chat has landed.
   2. Cold start, then open the long-chat bot.
   3. Warm switch between normal bots.
   4. Warm switch to the long-chat bot (first visit this launch, and coming back).
   Later: idle CPU over 60 s, RSS after N opens.
4. Tolerance: fail when a median is more than 20% over budget or the worst run is over its own budget.
5. Every run writes raw numbers + frame sheets + a dated write-up under `evals/results/`.
6. Runs locally on the Mac before merge (needs a real window and an unlocked screen, so no CI).

## Measurement method (this is where I want your pushback)

The prototype recorded the window at 30 fps (`winrec`) and clicked rail rows through the macOS
accessibility API (`cua-driver`, background, never the real pointer), timing from the first changed
frame after the click. Known traps from past sessions:
- The AX click lands 2-3 s after the call, so frame timing starts at the first change, which
  undercounts by ~300 ms (the SwiftUI build happens before any frame changes).
- AX clicking turns on SwiftUI's accessibility tree, which inflates row builds.
- A locked screen hides windows from AX.

My plan to fix it: add permanent, cheap instrumentation to the app:
- `os_signpost` / `Logger` events at "select bot requested" (in AppModel's selection path) and
  "transcript landed" (where `ChatView` sets `landedBotId`, see ChatView.swift ~lines 468-520, 744, 792),
  plus "app launched".
- A perf-only driver: the app listens for a DistributedNotification `com.usefulbot.perf.select` with a
  bot id, but only when launched with a `-UsefulBotPerfHooks YES` argument, so installed copies ignore it.
- The runner reads timestamps from `log show --predicate 'subsystem == "com.usefulbot.app"'` for the
  numbers, and still records 30 fps frames only as visual evidence (blank/mascot/jump) after "landed".

## Open questions

A. Is signpost select->landed the right metric, or does "landed" in ChatView fire before pixels are on
   screen (check `landRestored` and the two-frame wait)? What should mark the end?
B. The perf-hook DistributedNotification: acceptable, or is there a cleaner trigger (URL scheme, launch
   arg + AppleScript, XCUITest)? Any security concern with a launch-arg-gated listener?
C. Long-chat fixture. Chats live in eve (`.eve/.workflow-data`, 3.3 GB). The owner's real long chats
   (e.g. Drive Admin, 3,504 events) grow over time, so budgets drift. Options: (a) open real bots
   read-only and record event counts, re-baseline when they grow >X%; (b) seed a synthetic long chat on
   a dedicated bot once by driving real turns; (c) clone an eve session. Which, and why?
D. Noise: 5 runs, median + worst. Enough? Warm-up runs? Thermal/power state checks? Discard rules?
E. Anything missing that would make this guard give false passes or flaky fails?

Useful files to read (read excerpts, not whole files): `macos/Sources/UsefulBotApp/ChatView.swift`
(lines 20-130, 460-530, 730-800), `macos/Sources/UsefulBotApp/AppModel.swift` (search for
`func select`, `restore`, `ChatSnapshot`), `docs/audit/PERFORMANCE.md` (lines 1-130, 278-340).
