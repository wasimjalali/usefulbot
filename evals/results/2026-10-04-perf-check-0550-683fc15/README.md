# Performance check, 2026-10-04 05:50 (683fc15)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b2d155583281), git 683fc152c565, macOS 27.0.1, Apple M4.
Power AC, memory free 71%, load { 4.24 3.90 2.89 }, other work 40% CPU, web production.
Command: `perf/run.sh check`. Took 934 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 248.2 | 252.8 | 218.1 | 230.8 | 112.8 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 195.1 | 708.9 | 169.9 | 551.4 | 39.6 | disk_snapshot, none | settled |
| cold_launch | 10 | 931.4 | 1103.1 | 910.6 | 1072.9 | 6.7 | disk_snapshot, none | empty, settled |
| cold_no_snapshot_replies | 5 | 1389.0 | 1401.1 | 1235.1 | 1238.3 | 3.3 | none | settled |
| cold_no_snapshot_tools | 5 | 642.8 | 658.3 | 483.8 | 502.8 | 2.6 | none | settled |
| warm_return_replies | 30 | 220.7 | 242.5 | 200.8 | 213.4 | 107.2 | stash_snapshot | settled |
| warm_return_tools | 30 | 178.5 | 198.2 | 154.3 | 173.0 | 47.9 | stash_snapshot | settled |
| warm_switch_short | 10 | 187.1 | 205.7 | 157.1 | 178.3 | 26.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_first_open_tools: visual_ms worst 708.9 > 600.0
- cold_first_open_tools: took the none path, expected disk_snapshot
- cold_launch: cold-cold_first_open_tools-1: opened on Test Bot, not Perf Short A
- cold_launch: landing ended by empty
- cold_launch: took the none path, expected disk_snapshot

## Launch failures

- prep: recorder failed: perfrec: no "Useful Bot Dev" window for pid 15553


## Machine busy during the run (other work over 250% CPU)

- warm 440% (39% com.apple.dock.external.extra.arm64; 33% cmux; 33% WindowServer)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
