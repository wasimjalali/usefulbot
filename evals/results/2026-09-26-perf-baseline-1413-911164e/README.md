# Performance baseline, 2026-09-26 14:13 (911164e)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 0fbee62e1598), git 911164e21e9f with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 91%, load { 1.21 1.02 1.35 }, other work 14% CPU, web production.
Command: `perf/run.sh baseline`. Took 1090 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 5484.9 | 5606.4 | 4835.6 | 4854.1 | 3130.8 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 209.8 | 232.9 | 185.6 | 194.4 | 63.4 | disk_snapshot | settled |
| cold_launch | 10 | 610.4 | 637.5 | 592.0 | 627.4 | 18.9 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13280.2 | 13406.7 | 12031.0 | 12071.6 | 52.1 | none | cap |
| cold_no_snapshot_tools | 5 | 1402.0 | 10252.8 | 1228.1 | 10074.1 | 11.8 | none | cap, settled |
| warm_return_replies | 30 | 5431.0 | 6598.5 | 4793.8 | 5897.5 | 3375.3 | stash_snapshot | settled |
| warm_return_tools | 30 | 206.5 | 234.5 | 174.5 | 196.7 | 73.3 | stash_snapshot | settled |
| warm_switch_short | 10 | 164.8 | 195.7 | 135.7 | 170.4 | 37.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.
