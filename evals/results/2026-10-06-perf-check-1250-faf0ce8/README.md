# Performance check, 2026-10-06 12:50 (faf0ce8)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 f4f01075de65), git faf0ce8f8318, macOS 27.0.1, Apple M4.
Power AC, memory free 49%, load { 2.66 3.52 4.04 }, other work 158% CPU, web production.
Command: `perf/run.sh check`. Took 664 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 241.1 | 248.7 | 221.5 | 231.5 | 107.0 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 171.3 | 188.4 | 156.9 | 161.7 | 45.9 | disk_snapshot | settled |
| cold_launch | 10 | 978.5 | 1167.4 | 951.3 | 1142.1 | 2.1 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1443.0 | 1502.5 | 1280.3 | 1337.6 | 5.1 | none | settled |
| cold_no_snapshot_tools | 5 | 639.8 | 688.2 | 485.3 | 523.1 | 3.4 | none | settled |
| warm_return_replies | 30 | 230.8 | 250.3 | 209.3 | 225.4 | 113.7 | stash_snapshot | settled |
| warm_return_tools | 30 | 186.0 | 203.2 | 165.3 | 180.8 | 71.9 | stash_snapshot | settled |
| warm_switch_short | 10 | 190.6 | 211.6 | 172.1 | 186.8 | 6.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
