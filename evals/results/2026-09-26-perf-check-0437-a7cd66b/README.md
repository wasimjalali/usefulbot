# Performance check, 2026-09-26 04:37 (a7cd66b)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 db8a0b045663), git a7cd66beb74c with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 42%, load { 3.10 4.34 5.09 }, web production.
Command: `perf/run.sh check`. Took 1282 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 11624.5 | 18162.2 | 10204.5 | 16157.1 | 12084.1 | disk_snapshot | cap, settled |
| cold_first_open_tools | 5 | 668.8 | 10925.7 | 618.8 | 10735.4 | 1016.7 | disk_snapshot | cap, settled |
| cold_launch | 20 | 3245.4 | 9927.0 | 3189.1 | 9840.9 | 55.6 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 11656.2 | 12152.9 | 11431.1 | 11772.1 | 6.3 | none | cap |
| cold_no_snapshot_tools | 5 | 8363.5 | 9597.1 | 8139.9 | 9387.8 | 3.8 | none | settled |
| warm_return_replies | 30 | 13735.9 | 14068.4 | 12420.8 | 12746.8 | 53.1 | background_projection | cap |
| warm_return_tools | 30 | 905.4 | 1271.2 | 814.3 | 1199.6 | 929.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 1028.6 | 4043.9 | 952.5 | 3916.5 | 123.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 11624.5 > 7270.0
- cold_first_open_replies: visual_ms worst 18162.2 > 10900.0
- cold_first_open_replies: app_ms median 10204.5 > 6500.0
- cold_first_open_replies: app_ms worst 16157.1 > 9750.0
- cold_first_open_replies: stall_ms worst 12084.1 > 6360.0
- cold_first_open_replies: landing ended by cap
- cold_first_open_tools: visual_ms median 668.8 > 450.0
- cold_first_open_tools: visual_ms worst 10925.7 > 680.0
- cold_first_open_tools: app_ms median 618.8 > 400.0
- cold_first_open_tools: app_ms worst 10735.4 > 600.0
- cold_first_open_tools: stall_ms worst 1016.7 > 340.0
- cold_first_open_tools: landing ended by cap
- cold_launch: visual_ms median 3245.4 > 2840.0
- cold_launch: visual_ms worst 9927.0 > 8420.0
- cold_launch: app_ms median 3189.1 > 2780.0
- cold_launch: app_ms worst 9840.9 > 8320.0
- warm_return_replies: visual_ms median 13735.9 > 10380.0
- warm_return_replies: app_ms median 12420.8 > 9280.0
- warm_return_replies: landing ended by cap
- warm_return_replies: took the background_projection path, expected stash_snapshot
- warm_return_tools: visual_ms median 905.4 > 430.0
- warm_return_tools: visual_ms worst 1271.2 > 1140.0
- warm_return_tools: app_ms median 814.3 > 390.0
- warm_return_tools: app_ms worst 1199.6 > 1050.0
- warm_return_tools: stall_ms worst 929.4 > 920.0
- warm_switch_short: visual_ms median 1028.6 > 750.0
- warm_switch_short: visual_ms worst 4043.9 > 1130.0
- warm_switch_short: app_ms median 952.5 > 680.0
- warm_switch_short: app_ms worst 3916.5 > 1040.0

**Result: FAIL**

## Note added after the run

The machine got busy mid-run: another session started opencode perf audits (two models at about 80% CPU), and the load average rose from 3.1 at the start to 8 to 11. Every case slowed, including ones unrelated to the change. This result is inconclusive, not a regression. The guard now samples load at every launch and reports such a run as INCONCLUSIVE (exit 3).
