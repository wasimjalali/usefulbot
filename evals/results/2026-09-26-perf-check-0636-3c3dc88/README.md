# Performance check, 2026-09-26 06:36 (3c3dc88)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 cf7257d4a37a), git 3c3dc8869e79, macOS 26.6.2, Apple M1.
Power battery, memory free 39%, load { 3.91 3.15 3.40 }, web production.
Command: `perf/run.sh check`. Took 1141 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 6366.0 | 7760.6 | 5660.0 | 6917.5 | 4729.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 324.0 | 476.3 | 292.4 | 434.8 | 264.0 | disk_snapshot | settled |
| cold_launch | 10 | 1257.3 | 1977.3 | 1230.6 | 1945.9 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 12503.4 | 16998.8 | 11414.0 | 14948.9 | 6.2 | none | cap |
| cold_no_snapshot_tools | 5 | 11319.1 | 11367.7 | 11132.8 | 11183.4 | 5.2 | none | cap, settled |
| warm_return_replies | 30 | 4928.5 | 7701.0 | 4385.5 | 6846.8 | 4604.4 | stash_snapshot | settled |
| warm_return_tools | 30 | 311.4 | 443.2 | 284.5 | 413.3 | 290.2 | stash_snapshot | settled |
| warm_switch_short | 10 | 222.2 | 245.1 | 195.7 | 213.9 | 44.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 6366.0 > 6030.0
- cold_first_open_replies: app_ms median 5660.0 > 5390.0
- cold_first_open_replies: stall_ms median 3916.2 > 3490.0
- cold_first_open_replies: stall_ms worst 4729.9 > 3960.0
- cold_first_open_tools: stall_ms worst 264.0 > 220.0
- cold_launch: visual_ms median 1257.3 > 1120.0
- cold_launch: visual_ms worst 1977.3 > 1880.0
- cold_launch: app_ms median 1230.6 > 1100.0
- cold_launch: app_ms worst 1945.9 > 1860.0
- warm_return_replies: stall_ms worst 4604.4 > 3640.0
- warm_return_tools: stall_ms worst 290.2 > 220.0

## Machine busy during the run (1-minute load over 6.0)

cold-cold_first_open_tools-4 6.1, cold-cold_first_open_replies-4 6.7, cold-cold_first_open_tools-5 8.0, cold-cold_first_open_replies-5 7.4, cold-cold_no_snapshot_tools-1 10.2, cold-cold_no_snapshot_replies-1 15.2, cold-cold_no_snapshot_tools-2 12.9, cold-cold_no_snapshot_replies-2 10.0, cold-cold_no_snapshot_tools-3 8.0, cold-cold_no_snapshot_replies-3 8.1, cold-cold_no_snapshot_tools-4 6.5, cold-cold_no_snapshot_replies-4 7.1, cold-cold_no_snapshot_tools-5 7.0, cold-cold_no_snapshot_replies-5 6.0, end 10.3

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
