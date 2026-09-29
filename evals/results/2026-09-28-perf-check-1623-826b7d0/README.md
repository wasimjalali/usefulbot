# Performance check, 2026-09-28 16:23 (826b7d0)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 6aaf15bec88a), git 826b7d0ea3f0, macOS 26.6.2, Apple M1.
Power AC, memory free 46%, load { 4.45 3.59 3.45 }, other work 70% CPU, web production.
Command: `perf/run.sh check`. Took 835 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1745.3 | 3912.4 | 1511.0 | 3115.1 | 2865.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 314.9 | 609.1 | 279.9 | 565.4 | 413.8 | disk_snapshot | settled |
| cold_launch | 10 | 1023.2 | 3684.6 | 987.1 | 3615.7 | 18.6 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5920.1 | 6830.7 | 5482.7 | 6387.8 | 21.5 | none | settled |
| cold_no_snapshot_tools | 5 | 1571.6 | 1677.1 | 1391.7 | 1498.2 | 63.7 | none | settled |
| warm_return_replies | 30 | 1597.7 | 1610.4 | 1396.3 | 1404.8 | 955.9 | stash_snapshot | settled |
| warm_return_tools | 30 | 304.6 | 336.4 | 276.9 | 299.5 | 155.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 245.0 | 294.7 | 216.0 | 263.8 | 37.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms worst 3912.4 > 2910.0
- cold_first_open_replies: app_ms worst 3115.1 > 2540.0
- cold_first_open_replies: stall_ms median 1208.5 > 1100.0
- cold_first_open_replies: stall_ms worst 2865.9 > 1130.0
- cold_first_open_tools: visual_ms worst 609.1 > 600.0
- cold_first_open_tools: app_ms worst 565.4 > 560.0
- cold_first_open_tools: stall_ms worst 413.8 > 220.0
- cold_launch: visual_ms worst 3684.6 > 1880.0
- cold_launch: app_ms worst 3615.7 > 1860.0

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_tools-1 332% (88% Vivaldi; 41% WindowServer; 32% ControlCenter)
- cold-cold_first_open_replies-1 677% (120% Browser; 92% WindowServer; 58% CarbonComponentScannerXPC)
- cold-cold_first_open_tools-2 268% (79% mobileassetd; 47% WindowServer; 29% ControlCenter)
- cold-cold_first_open_replies-2 376% (165% Vivaldi; 40% claude; 34% WindowServer)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
