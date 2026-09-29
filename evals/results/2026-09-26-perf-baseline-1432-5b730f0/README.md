# Performance baseline, 2026-09-26 14:32 (5b730f0)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 f810881ca3c3), git 5b730f0b8cf4 with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 90%, load { 1.58 1.51 1.50 }, other work 68% CPU, web production.
Command: `perf/run.sh baseline`. Took 839 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1067.9 | 1079.6 | 928.6 | 939.5 | 936.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 204.6 | 224.4 | 178.4 | 189.8 | 59.8 | disk_snapshot | settled |
| cold_launch | 10 | 609.0 | 624.5 | 588.9 | 611.7 | 12.1 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13143.9 | 13201.8 | 12706.3 | 12770.6 | 11.2 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 1458.7 | 1468.5 | 1284.5 | 1291.8 | 22.1 | none | settled |
| warm_return_replies | 30 | 1045.5 | 1260.8 | 907.4 | 1109.5 | 1027.6 | stash_snapshot | settled |
| warm_return_tools | 30 | 193.7 | 212.3 | 163.1 | 181.9 | 69.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 160.0 | 187.2 | 134.6 | 160.8 | 61.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.
