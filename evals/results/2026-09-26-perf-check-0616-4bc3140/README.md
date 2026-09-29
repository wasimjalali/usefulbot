# Performance check, 2026-09-26 06:16 (4bc3140)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 cf7257d4a37a), git 4bc3140f861f, macOS 26.6.2, Apple M1.
Power battery, memory free 39%, load { 2.16 2.45 2.94 }, web production.
Command: `perf/run.sh check`. Took 1128 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 5297.8 | 6827.0 | 4732.2 | 6099.4 | 4535.2 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 335.7 | 484.4 | 304.5 | 444.1 | 266.0 | disk_snapshot | settled |
| cold_launch | 10 | 1231.8 | 2702.0 | 1202.6 | 2658.9 | 2.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 12389.3 | 12836.7 | 11399.5 | 11747.9 | 5.4 | none | cap |
| cold_no_snapshot_tools | 5 | 11350.4 | 11366.7 | 11173.7 | 11188.9 | 4.7 | none | cap |
| warm_return_replies | 30 | 4951.1 | 5942.0 | 4415.5 | 5335.7 | 3286.1 | stash_snapshot | settled |
| warm_return_tools | 30 | 310.8 | 400.0 | 276.2 | 369.9 | 202.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 216.3 | 251.3 | 197.0 | 219.0 | 38.9 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_launch: visual_ms median 1231.8 > 1120.0
- cold_launch: visual_ms worst 2702.0 > 1880.0
- cold_launch: app_ms median 1202.6 > 1100.0
- cold_launch: app_ms worst 2658.9 > 1860.0

## Machine busy during the run (1-minute load over 6.0)

cold-cold_first_open_tools-1 8.5, cold-cold_first_open_replies-1 7.0, cold-cold_first_open_tools-2 6.2, cold-cold_first_open_tools-5 7.7, cold-cold_first_open_replies-5 10.8, cold-cold_no_snapshot_tools-1 8.4, cold-cold_no_snapshot_replies-1 6.9

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
