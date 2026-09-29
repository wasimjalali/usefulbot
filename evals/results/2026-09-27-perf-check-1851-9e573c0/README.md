# Performance check, 2026-09-27 18:51 (9e573c0)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git 9e573c06bcfc, macOS 26.6.2, Apple M1.
Power AC, memory free 48%, load { 1.29 2.42 3.35 }, other work 102% CPU, web production.
Command: `perf/run.sh check`. Took 794 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1668.9 | 1720.1 | 1461.7 | 1498.9 | 1001.3 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 314.2 | 346.2 | 277.7 | 307.0 | 160.4 | disk_snapshot | settled |
| cold_launch | 10 | 908.3 | 1027.6 | 882.7 | 1009.8 | 1.8 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5183.8 | 5910.4 | 4747.7 | 5459.6 | 2.4 | none | settled |
| cold_no_snapshot_tools | 5 | 1504.3 | 1763.6 | 1288.8 | 1586.4 | 3.9 | none | settled |
| warm_return_replies | 30 | 1606.2 | 1641.9 | 1401.3 | 1432.5 | 967.2 | stash_snapshot | settled |
| warm_return_tools | 30 | 333.9 | 379.6 | 294.3 | 337.6 | 168.8 | stash_snapshot | settled |
| warm_switch_short | 10 | 252.4 | 325.4 | 223.7 | 293.6 | 2.7 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
