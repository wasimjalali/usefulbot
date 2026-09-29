# Performance check, 2026-09-29 18:45 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 b262ac9a8876), git e1b27bc04172 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 52%, load { 2.88 2.52 2.36 }, other work 26% CPU, web production.
Command: `perf/run.sh check --quick`. Took 268 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 1620.3 | 1623.3 | 1405.8 | 1406.2 | 757.3 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 703.8 | 1114.9 | 275.0 | 283.2 | 80.5 | disk_snapshot | settled |
| cold_launch | 4 | 854.6 | 873.6 | 835.1 | 859.1 | 1.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 5904.6 | 5904.6 | 5480.7 | 5480.7 | 1.3 | none | settled |
| cold_no_snapshot_tools | 1 | 1732.9 | 1732.9 | 1558.4 | 1558.4 | 56.1 | none | settled |
| warm_return_replies | 6 | 1584.4 | 1811.2 | 1384.9 | 1609.5 | 780.1 | stash_snapshot | settled |
| warm_return_tools | 6 | 1245.3 | 1532.6 | 276.2 | 284.0 | 83.3 | stash_snapshot | settled |
| warm_switch_short | 4 | 240.5 | 245.2 | 206.3 | 210.3 | 1.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_tools: visual_ms median 703.8 > 400.0
- cold_first_open_tools: visual_ms worst 1114.9 > 600.0
- warm_return_tools: visual_ms median 1245.3 > 390.0
- warm_return_tools: visual_ms worst 1532.6 > 580.0

## Machine busy during the run (other work over 250% CPU)

- prep 257% (34% WindowServer; 34% siriknowledged; 21% syspolicyd)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
