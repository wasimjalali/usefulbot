# Performance check, 2026-09-27 18:37 (79fa843)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git 79fa843d378b, macOS 26.6.2, Apple M1.
Power AC, memory free 53%, load { 2.25 4.70 4.68 }, other work 164% CPU, web production.
Command: `perf/run.sh check`. Took 786 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1647.9 | 1669.1 | 1430.3 | 1443.3 | 968.6 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 321.2 | 334.8 | 293.4 | 297.1 | 181.8 | disk_snapshot | settled |
| cold_launch | 10 | 912.6 | 950.9 | 888.3 | 920.3 | 2.9 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5327.2 | 6002.5 | 4884.5 | 5556.5 | 6.5 | none | settled |
| cold_no_snapshot_tools | 5 | 1501.5 | 1599.7 | 1324.8 | 1406.3 | 2.4 | none | settled |
| warm_return_replies | 30 | 1608.2 | 4117.3 | 1387.9 | 1441.4 | 1057.6 | stash_snapshot | settled |
| warm_return_tools | 30 | 324.8 | 403.5 | 288.1 | 324.3 | 155.1 | stash_snapshot | settled |
| warm_switch_short | 10 | 253.5 | 294.2 | 219.4 | 247.6 | 1.9 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- warm_return_replies: warm: nothing changed on screen
- warm_return_tools: warm: nothing changed on screen
- warm_return_tools: warm: nothing changed on screen

## Machine busy during the run (other work over 250% CPU)

- cold-cold_no_snapshot_replies-1 321% (47% WindowServer; 43% PerfPowerServices; 41% modelcatalogd)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
