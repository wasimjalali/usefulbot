# Performance check, 2026-09-26 05:03 (0caa10d)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 db8a0b045663), git 0caa10dea2e9, macOS 26.6.2, Apple M1.
Power AC, memory free 29%, load { 3.23 7.64 9.88 }, web production.
Command: `perf/run.sh check`. Took 538 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 15870.4 | 17218.7 | 14166.4 | 15753.5 | 9640.5 | disk_snapshot | cap, settled |
| cold_first_open_tools | 5 | 742.7 | 913.8 | 676.4 | 848.1 | 722.9 | disk_snapshot | settled |
| cold_launch | 20 | 2975.1 | 4732.5 | 2922.4 | 4680.2 | 31.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 337.1 | 12287.3 | 11338.6 | 11911.2 | 4.2 | none | cap |
| cold_no_snapshot_tools | 5 | 11368.1 | 11640.9 | 11134.5 | 11418.7 | 4.4 | none | cap, settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 15870.4 > 7270.0
- cold_first_open_replies: visual_ms worst 17218.7 > 10900.0
- cold_first_open_replies: app_ms median 14166.4 > 6500.0
- cold_first_open_replies: app_ms worst 15753.5 > 9750.0
- cold_first_open_replies: stall_ms worst 9640.5 > 6360.0
- cold_first_open_replies: landing ended by cap
- cold_first_open_tools: visual_ms median 742.7 > 450.0
- cold_first_open_tools: visual_ms worst 913.8 > 680.0
- cold_first_open_tools: app_ms median 676.4 > 400.0
- cold_first_open_tools: app_ms worst 848.1 > 600.0
- cold_first_open_tools: stall_ms worst 722.9 > 340.0
- cold_launch: visual_ms median 2975.1 > 2840.0
- cold_launch: app_ms median 2922.4 > 2780.0
- cold_no_snapshot_tools: visual_ms median 11368.1 > 10520.0
- cold_no_snapshot_tools: app_ms median 11134.5 > 10200.0
- warm_return_replies: not measured
- warm_return_tools: not measured
- warm_switch_short: not measured

## Launch failures

- warm: the app aborted the scenario: step 2: Perf Long Replies never landed

## Machine busy during the run (1-minute load over 6.0)

cold-cold_first_open_tools-1 10.1, cold-cold_first_open_replies-1 9.4, cold-cold_first_open_tools-2 9.8, cold-cold_first_open_replies-2 9.6, cold-cold_first_open_tools-3 10.3, cold-cold_first_open_replies-3 15.8, cold-cold_first_open_tools-4 13.7, cold-cold_first_open_replies-4 11.9, cold-cold_first_open_tools-5 11.7, cold-cold_first_open_replies-5 12.6, cold-cold_no_snapshot_tools-1 10.4, cold-cold_no_snapshot_replies-1 9.5, cold-cold_no_snapshot_tools-2 12.3, cold-cold_no_snapshot_replies-2 13.3, cold-cold_no_snapshot_tools-3 12.1, cold-cold_no_snapshot_replies-3 14.7, cold-cold_no_snapshot_tools-4 14.3, cold-cold_no_snapshot_replies-4 21.6, cold-cold_no_snapshot_tools-5 19.9, cold-cold_no_snapshot_replies-5 17.6, warm 16.4, end 14.2

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
