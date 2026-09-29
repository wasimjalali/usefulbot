# Performance check, 2026-09-26 15:01 (5b730f0)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 f810881ca3c3), git 5b730f0b8cf4 with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 90%, load { 1.02 1.39 1.50 }, other work 13% CPU, web production.
Command: `perf/run.sh check`. Took 1003 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1752.5 | 10538.5 | 1538.9 | 10269.1 | 1635.1 | disk_snapshot | cap, settled |
| cold_first_open_tools | 5 | 360.7 | 4088.9 | 328.9 | 4028.2 | 108.8 | disk_snapshot | settled |
| cold_launch | 10 | 835.0 | 2994.2 | 734.9 | 2956.1 | 16.7 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 14862.5 | 19018.3 | 14208.9 | 18306.8 | 18.5 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 2999.3 | 5214.6 | 2792.9 | 5044.6 | 12.2 | none | settled |
| warm_return_replies | 30 | 1572.9 | 10468.8 | 1373.2 | 10258.4 | 1443.2 | stash_snapshot | cap, settled |
| warm_return_tools | 30 | 268.4 | 5009.8 | 208.9 | 4900.4 | 172.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 240.5 | 3527.4 | 196.4 | 3505.2 | 34.6 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 1752.5 > 1300.0
- cold_first_open_replies: visual_ms worst 10538.5 > 1950.0
- cold_first_open_replies: app_ms median 1538.9 > 1130.0
- cold_first_open_replies: app_ms worst 10269.1 > 1700.0
- cold_first_open_replies: stall_ms median 1387.3 > 1140.0
- cold_first_open_replies: stall_ms worst 1635.1 > 1170.0
- cold_first_open_replies: landing ended by cap
- cold_first_open_tools: visual_ms median 360.7 > 270.0
- cold_first_open_tools: visual_ms worst 4088.9 > 400.0
- cold_first_open_tools: app_ms median 328.9 > 230.0
- cold_first_open_tools: app_ms worst 4028.2 > 340.0
- cold_launch: visual_ms median 835.0 > 750.0
- cold_launch: visual_ms worst 2994.2 > 1120.0
- cold_launch: app_ms median 734.9 > 730.0
- cold_launch: app_ms worst 2956.1 > 1100.0
- cold_no_snapshot_tools: visual_ms median 2999.3 > 1770.0
- cold_no_snapshot_tools: visual_ms worst 5214.6 > 2660.0
- cold_no_snapshot_tools: app_ms median 2792.9 > 1560.0
- cold_no_snapshot_tools: app_ms worst 5044.6 > 2340.0
- warm_return_replies: visual_ms median 1572.9 > 1270.0
- warm_return_replies: visual_ms worst 10468.8 > 1900.0
- warm_return_replies: app_ms median 1373.2 > 1110.0
- warm_return_replies: app_ms worst 10258.4 > 1660.0
- warm_return_replies: stall_ms median 1315.8 > 1120.0
- warm_return_replies: stall_ms worst 1443.2 > 1280.0
- warm_return_replies: landing ended by cap
- warm_return_tools: visual_ms median 268.4 > 250.0
- warm_return_tools: visual_ms worst 5009.8 > 380.0
- warm_return_tools: app_ms worst 4900.4 > 330.0
- warm_return_tools: stall_ms worst 172.4 > 150
- warm_switch_short: visual_ms median 240.5 > 210.0
- warm_switch_short: visual_ms worst 3527.4 > 320.0
- warm_switch_short: app_ms median 196.4 > 180.0
- warm_switch_short: app_ms worst 3505.2 > 270.0

**Result: FAIL**
