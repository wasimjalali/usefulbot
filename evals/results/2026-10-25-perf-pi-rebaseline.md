# Perf guard on the Pi engine: re-baseline (2026-10-25)

## Question

PR #220 swapped eve for the Pi engine and removed chat snapshots. Every budget in
`perf/budgets.json` was measured on eve. How fast does the app open chats on Pi, and what should the
guard enforce from here?

## What ran

- `perf/run.sh fixtures` (the four synthetic "Perf" chats, written as Pi session files and locked in
  `perf/fixtures.dev.lock.json`), then `perf/run.sh baseline` three times and `npm run perf:check`
  once, all through the heavy lock, on Useful Bot Dev built from `main` at `092a205` plus the harness
  fixes below (the records say "092a205 with uncommitted changes": those fixes, committed in this
  PR). Apple M4, macOS 27.0.1, on AC power. No model calls, so no cost.
- **Run 1 (`2026-10-25-perf-baseline-1721-092a205`) measured nothing usable.** The app started the
  harness before it had opened its launch chat, so the `ready` mark named no chat, every cold launch
  failed its "opened on Perf Short A" check and the warm scenario's first select raced the launch
  chat's open and never landed. Fix: `AppModel` starts the harness after the launch chat is open.
- **Run 2 (`...-1726-...`) measured every case.** Its first cold launch opened on the chat the last
  run restored, because the runner had no launch that parks on Perf Short A first. Fix: an untimed
  `prep` launch, as the README already described.
- **Run 3 (`...-1736-...`) has no breaches,** but the runner flagged four launches as busy: other
  work peaked at 715% CPU, most of it the Claude app that ran this session (one process at 206%).
  Run 2 was busier still (Spotlight workers at up to 686%). Its verdict is INCONCLUSIVE, so the
  budgets rest on the agreement below, not on run 3 alone: runs 2 and 3 agree within 6% on every
  visual and app median.
- **The check (`2026-10-25-perf-check-1746-092a205`) passes** against those budgets, with no busy
  launch: every visual and app median within 8% of run 3 (the rows and stall marks, tens of ms,
  vary more). This is the release's perf gate.

## Numbers (run 3, ms)

| Case | Visual median | Visual worst | Rows done median | eve visual median |
|---|---|---|---|---|
| cold_launch | 1,110 | 1,179 | 767 | about 920 |
| cold_first_open_tools | 408 | 448 | 67 | about 320 |
| cold_first_open_replies | 767 | 805 | 71 | about 1,600 |
| warm_switch_short | 356 | 455 | 75 | about 225 |
| warm_return_tools | 394 | 473 | 66 | about 310 |
| warm_return_replies | 775 | 912 | 68 | about 1,550 |

The eve column is the median the old budgets imply (budget = median × 1.2 + 20 ms).

## What the numbers say

- **Long markdown chats are about twice as fast,** and the main-thread stall after landing fell from
  about 900 ms to under 70 ms. The Pi engine sends rows the app paints in about 70 ms.
- **Short chats and launch are slower** (about 130 ms on a short switch, 190 ms on launch). Rows are
  done in about 70 ms; the rest is the landing gate. On eve a revisited chat came back from a saved
  snapshot and landed at once. Without snapshots every open waits out the gate's steady checks
  (at least three 50 ms checks after the rows are in).

## What changed because of it

- `perf/budgets.json` holds the Pi numbers for every case, with `rows_first_paint_ms` and
  `rows_done_ms` added. The long markdown cases tightened; short switch, launch and the tools cases
  were raised to what Pi measures, with the reason in the file's `_about`.
- The two harness fixes above.
- Follow-up: land short chats without waiting out the full steady gate.
