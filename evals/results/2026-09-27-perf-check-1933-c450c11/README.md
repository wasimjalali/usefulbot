# Performance check, 2026-09-27 19:33 (c450c11)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git c450c118e2c2 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 55%, load { 3.90 2.31 2.11 }, other work 81% CPU, web production.
Command: `perf/run.sh check`. Took 796 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 3 | 1599.6 | 1621.4 | 1389.0 | 1411.6 | 913.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 310.9 | 326.6 | 276.1 | 292.0 | 137.4 | disk_snapshot | settled |
| cold_launch | 8 | 875.3 | 916.1 | 851.7 | 899.5 | 3.6 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5471.8 | 5856.5 | 5042.6 | 5427.7 | 2.9 | none | settled |
| cold_no_snapshot_tools | 5 | 1516.7 | 1760.1 | 1348.7 | 1602.4 | 53.0 | none | settled |
| warm_return_replies | 30 | 1545.2 | 1566.3 | 1349.8 | 1370.0 | 936.1 | stash_snapshot | settled |
| warm_return_tools | 30 | 288.6 | 318.3 | 254.4 | 280.2 | 143.5 | stash_snapshot | settled |
| warm_switch_short | 10 | 245.8 | 286.3 | 217.3 | 262.9 | 54.8 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Launch failures

- cold-cold_first_open_replies-1: the app exited before the scenario ended
- cold-cold_first_open_replies-4: the app exited before the scenario ended

**Result: FAIL**
