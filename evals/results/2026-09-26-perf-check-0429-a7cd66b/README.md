# Performance check, 2026-09-26 04:29 (a7cd66b)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 ff91a7ea2513), git a7cd66beb74c with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 35%, load { 6.00 5.64 5.74 }, web production.
Command: `perf/run.sh check --quick`. Took 399 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 9694.7 | 9816.1 | 8647.0 | 8769.6 | 6018.3 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 778.2 | 781.9 | 741.4 | 742.8 | 295.4 | disk_snapshot | settled |
| cold_launch | 6 | 1436.2 | 2208.2 | 1379.8 | 2156.6 | 7.1 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 11231.6 | 11231.6 | 11047.1 | 11047.1 | 6247.2 | none | cap |
| cold_no_snapshot_tools | 1 | 4102.3 | 4102.3 | 3928.4 | 3928.4 | 3.0 | none | settled |
| warm_return_replies | 6 | 9475.0 | 11671.6 | 8510.6 | 10281.5 | 5834.9 | stash_snapshot | settled |
| warm_return_tools | 6 | 880.9 | 1416.4 | 843.9 | 1355.5 | 683.3 | stash_snapshot | settled |
| warm_switch_short | 4 | 683.7 | 721.1 | 651.0 | 688.0 | 64.7 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: visual_ms median 9694.7 > 7270.0
- cold_first_open_replies: app_ms median 8647.0 > 6500.0
- cold_first_open_tools: visual_ms median 778.2 > 450.0
- cold_first_open_tools: visual_ms worst 781.9 > 680.0
- cold_first_open_tools: app_ms median 741.4 > 400.0
- cold_first_open_tools: app_ms worst 742.8 > 600.0
- warm_return_tools: visual_ms median 880.9 > 430.0
- warm_return_tools: visual_ms worst 1416.4 > 1140.0
- warm_return_tools: app_ms median 843.9 > 390.0
- warm_return_tools: app_ms worst 1355.5 > 1050.0

**Result: FAIL**
