# Performance check, 2026-10-04 22:20 (8427895)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 48d7bc1cc9ae), git 8427895db91e with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 67%, load { 1.44 1.56 1.76 }, other work 151% CPU, web production.
Command: `perf/run.sh check`. Took 654 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 234.6 | 247.3 | 210.0 | 219.7 | 94.6 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 177.2 | 183.5 | 148.2 | 161.5 | 36.6 | disk_snapshot | settled |
| cold_launch | 10 | 926.9 | 1102.4 | 904.6 | 1070.5 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1400.5 | 1414.5 | 1243.4 | 1247.1 | 2.8 | none | settled |
| cold_no_snapshot_tools | 5 | 637.8 | 641.4 | 478.1 | 479.8 | 2.5 | none | settled |
| warm_return_replies | 30 | 220.8 | 248.8 | 198.1 | 223.9 | 111.9 | stash_snapshot | settled |
| warm_return_tools | 30 | 177.2 | 205.1 | 157.3 | 176.8 | 73.1 | stash_snapshot | settled |
| warm_switch_short | 10 | 174.3 | 203.6 | 157.5 | 182.9 | 3.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- warm 684% (164% Claude; 159% Claude; 44% Claude)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
