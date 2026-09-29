# Performance check, 2026-09-26 15:20 (5b730f0)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 c146020025dc), git 5b730f0b8cf4 with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 90%, load { 0.88 1.55 1.70 }, other work 2% CPU, web production.
Command: `perf/run.sh check`. Took 944 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1962.2 | 1996.3 | 1766.9 | 1789.6 | 1326.8 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 642.1 | 659.4 | 596.8 | 621.7 | 109.7 | disk_snapshot | settled |
| cold_launch | 10 | 753.6 | 828.7 | 714.5 | 774.7 | 39.6 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13217.2 | 13433.3 | 12608.5 | 12872.3 | 10.9 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 2369.1 | 2450.9 | 2187.0 | 2249.4 | 35.4 | none | settled |
| warm_return_replies | 30 | 2027.6 | 2248.4 | 1811.0 | 2044.1 | 1545.9 | stash_snapshot | settled |
| warm_return_tools | 30 | 637.5 | 772.0 | 597.2 | 622.2 | 166.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 577.6 | 610.1 | 542.9 | 566.9 | 40.1 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 1962.2 > 1300.0
- cold_first_open_replies: visual_ms worst 1996.3 > 1950.0
- cold_first_open_replies: app_ms median 1766.9 > 1130.0
- cold_first_open_replies: app_ms worst 1789.6 > 1700.0
- cold_first_open_replies: stall_ms median 1283.7 > 1140.0
- cold_first_open_replies: stall_ms worst 1326.8 > 1170.0
- cold_first_open_tools: visual_ms median 642.1 > 270.0
- cold_first_open_tools: visual_ms worst 659.4 > 400.0
- cold_first_open_tools: app_ms median 596.8 > 230.0
- cold_first_open_tools: app_ms worst 621.7 > 340.0
- cold_launch: visual_ms median 753.6 > 750.0
- cold_no_snapshot_tools: visual_ms median 2369.1 > 1770.0
- cold_no_snapshot_tools: app_ms median 2187.0 > 1560.0
- warm_return_replies: visual_ms median 2027.6 > 1270.0
- warm_return_replies: visual_ms worst 2248.4 > 1900.0
- warm_return_replies: app_ms median 1811.0 > 1110.0
- warm_return_replies: app_ms worst 2044.1 > 1660.0
- warm_return_replies: stall_ms median 1297.0 > 1120.0
- warm_return_replies: stall_ms worst 1545.9 > 1280.0
- warm_return_tools: visual_ms median 637.5 > 250.0
- warm_return_tools: visual_ms worst 772.0 > 380.0
- warm_return_tools: app_ms median 597.2 > 220.0
- warm_return_tools: app_ms worst 622.2 > 330.0
- warm_return_tools: stall_ms worst 166.4 > 150
- warm_switch_short: visual_ms median 577.6 > 210.0
- warm_switch_short: visual_ms worst 610.1 > 320.0
- warm_switch_short: app_ms median 542.9 > 180.0
- warm_switch_short: app_ms worst 566.9 > 270.0

**Result: FAIL**
