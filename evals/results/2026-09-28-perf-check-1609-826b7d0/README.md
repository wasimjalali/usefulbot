# Performance check, 2026-09-28 16:09 (826b7d0)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 6aaf15bec88a), git 826b7d0ea3f0, macOS 26.6.2, Apple M1.
Power AC, memory free 55%, load { 1.93 2.94 3.29 }, other work 142% CPU, web production.
Command: `perf/run.sh check`. Took 803 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1666.9 | 1811.4 | 1446.8 | 1555.9 | 1187.1 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 309.3 | 322.2 | 276.8 | 293.2 | 158.1 | disk_snapshot | settled |
| cold_launch | 10 | 916.9 | 1204.2 | 887.6 | 1170.6 | 1.7 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5207.0 | 7035.3 | 4790.8 | 6610.6 | 29.3 | none | settled |
| cold_no_snapshot_tools | 5 | 1620.5 | 1701.4 | 1441.9 | 1530.4 | 77.4 | none | settled |
| warm_return_replies | 30 | 1600.3 | 1819.5 | 1397.3 | 1621.4 | 988.4 | stash_snapshot | settled |
| warm_return_tools | 30 | 320.7 | 342.2 | 285.0 | 307.0 | 157.7 | stash_snapshot | settled |
| warm_switch_short | 10 | 240.9 | 253.6 | 211.6 | 217.4 | 32.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_replies: stall_ms worst 1187.1 > 1130.0

## Machine busy during the run (other work over 250% CPU)

- cold-cold_no_snapshot_replies-1 364% (80% siriinferenced; 56% BackgroundShortcutRunner; 50% WindowServer)
- cold-cold_no_snapshot_tools-3 324% (197% Vivaldi; 41% WindowServer; 39% ControlCenter)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
