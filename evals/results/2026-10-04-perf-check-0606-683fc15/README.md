# Performance check, 2026-10-04 06:06 (683fc15)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b2d155583281), git 683fc152c565, macOS 27.0.1, Apple M4.
Power AC, memory free 69%, load { 3.45 2.16 2.19 }, other work 218% CPU, web production.
Command: `perf/run.sh check`. Took 656 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 240.7 | 257.0 | 213.4 | 230.7 | 114.6 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 185.1 | 187.3 | 159.1 | 170.1 | 42.1 | disk_snapshot | settled |
| cold_launch | 10 | 830.1 | 1098.8 | 800.9 | 1071.5 | 1.7 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1407.9 | 1503.8 | 1246.7 | 1346.2 | 4.9 | none | settled |
| cold_no_snapshot_tools | 5 | 645.0 | 656.4 | 480.8 | 498.3 | 2.3 | none | settled |
| warm_return_replies | 30 | 219.7 | 232.6 | 195.3 | 201.2 | 92.8 | stash_snapshot | settled |
| warm_return_tools | 30 | 177.5 | 189.2 | 150.4 | 159.6 | 58.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 186.7 | 203.2 | 163.1 | 173.4 | 16.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- prep 373% (94% XProtectRemediatorPirrit; 61% XProtectRemediatorSheepSwap; 58% Python)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
