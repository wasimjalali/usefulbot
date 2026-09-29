# Performance check, 2026-09-26 14:47 (5b730f0)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 f810881ca3c3), git 5b730f0b8cf4 with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 90%, load { 1.11 1.38 1.51 }, other work 14% CPU, web production.
Command: `perf/run.sh check`. Took 857 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1060.3 | 1069.8 | 920.7 | 925.4 | 926.8 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 202.2 | 210.8 | 170.3 | 180.8 | 69.9 | disk_snapshot | settled |
| cold_launch | 10 | 591.4 | 605.4 | 572.6 | 586.0 | 14.6 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13082.2 | 13244.4 | 12643.3 | 12720.7 | 11.3 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 1431.1 | 1493.5 | 1268.6 | 1307.2 | 27.4 | none | settled |
| warm_return_replies | 30 | 1223.1 | 10584.2 | 1048.0 | 10324.5 | 1390.8 | stash_snapshot | cap, settled |
| warm_return_tools | 30 | 205.1 | 4846.4 | 167.3 | 4795.9 | 119.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 185.4 | 1054.7 | 142.0 | 947.0 | 23.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- warm_return_replies: visual_ms worst 10584.2 > 1900.0
- warm_return_replies: app_ms worst 10324.5 > 1660.0
- warm_return_replies: stall_ms worst 1390.8 > 1280.0
- warm_return_replies: landing ended by cap
- warm_return_tools: visual_ms worst 4846.4 > 380.0
- warm_return_tools: app_ms worst 4795.9 > 330.0
- warm_switch_short: visual_ms worst 1054.7 > 320.0
- warm_switch_short: app_ms worst 947.0 > 270.0

**Result: FAIL**
