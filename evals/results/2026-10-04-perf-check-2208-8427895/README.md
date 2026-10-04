# Performance check, 2026-10-04 22:08 (8427895)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 48d7bc1cc9ae), git 8427895db91e with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 66%, load { 1.96 1.90 2.02 }, other work 48% CPU, web production.
Command: `perf/run.sh check`. Took 662 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 241.6 | 248.7 | 215.9 | 222.7 | 94.0 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 182.7 | 183.5 | 159.0 | 165.7 | 35.4 | disk_snapshot | settled |
| cold_launch | 10 | 819.2 | 1128.4 | 796.5 | 1102.1 | 1.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1407.6 | 1507.6 | 1255.1 | 1349.5 | 5.1 | none | settled |
| cold_no_snapshot_tools | 5 | 643.2 | 660.5 | 477.8 | 493.1 | 2.4 | none | settled |
| warm_return_replies | 30 | 216.2 | 229.0 | 194.9 | 207.0 | 91.9 | stash_snapshot | settled |
| warm_return_tools | 30 | 173.8 | 185.3 | 152.9 | 168.1 | 48.7 | stash_snapshot | settled |
| warm_switch_short | 10 | 182.4 | 204.6 | 166.7 | 176.5 | 2.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_replies-1 505% (66% linkd; 64% deleted; 58% mobileassetd)
- cold-cold_first_open_tools-2 435% (76% linkd; 72% deleted; 65% mobileassetd)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
