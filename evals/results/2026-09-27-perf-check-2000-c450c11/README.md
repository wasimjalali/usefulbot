# Performance check, 2026-09-27 20:00 (c450c11)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git c450c118e2c2 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 46%, load { 2.03 1.77 1.85 }, other work 120% CPU, web production.
Command: `perf/run.sh check`. Took 791 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1605.1 | 1623.1 | 1394.0 | 1403.8 | 910.0 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 296.2 | 316.0 | 257.0 | 282.7 | 137.5 | disk_snapshot | settled |
| cold_launch | 10 | 875.0 | 903.1 | 849.0 | 871.9 | 2.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5527.0 | 5657.1 | 5096.6 | 5231.4 | 3.0 | none | settled |
| cold_no_snapshot_tools | 5 | 1539.8 | 1792.7 | 1366.4 | 1638.0 | 47.6 | none | settled |
| warm_return_replies | 30 | 1548.5 | 1584.3 | 1351.8 | 1385.7 | 925.4 | stash_snapshot | settled |
| warm_return_tools | 30 | 306.7 | 323.5 | 272.8 | 286.1 | 131.8 | stash_snapshot | settled |
| warm_switch_short | 10 | 253.0 | 263.6 | 225.2 | 237.8 | 55.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
