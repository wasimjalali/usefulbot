# Performance check, 2026-10-06 22:53 (03e91ce)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 7d535b2138dd), git 03e91ce7b6ff, macOS 27.0.1, Apple M4.
Power AC, memory free 63%, load { 2.60 2.77 2.69 }, other work 40% CPU, web production.
Command: `perf/run.sh check`. Took 666 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 248.6 | 257.0 | 226.8 | 241.9 | 106.8 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 196.4 | 204.1 | 176.5 | 190.3 | 41.8 | disk_snapshot | settled |
| cold_launch | 10 | 860.9 | 1149.3 | 841.1 | 1117.1 | 1.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1462.2 | 1489.1 | 1298.1 | 1329.9 | 4.3 | none | settled |
| cold_no_snapshot_tools | 5 | 686.2 | 698.8 | 519.9 | 539.1 | 4.7 | none | settled |
| warm_return_replies | 30 | 229.4 | 242.7 | 205.7 | 216.8 | 104.8 | stash_snapshot | settled |
| warm_return_tools | 30 | 186.6 | 210.7 | 167.0 | 181.5 | 62.1 | stash_snapshot | settled |
| warm_switch_short | 10 | 203.7 | 211.9 | 183.2 | 191.6 | 33.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
