# Performance check, 2026-09-27 19:46 (c450c11)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git c450c118e2c2 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 49%, load { 3.35 2.32 2.09 }, other work 63% CPU, web production.
Command: `perf/run.sh check`. Took 787 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1588.8 | 1600.9 | 1375.8 | 1388.5 | 909.5 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 292.6 | 358.8 | 259.8 | 326.1 | 134.5 | disk_snapshot | settled |
| cold_launch | 10 | 856.0 | 899.3 | 829.8 | 872.0 | 2.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5502.2 | 5600.0 | 5071.7 | 5171.2 | 3.0 | none | settled |
| cold_no_snapshot_tools | 5 | 1544.2 | 1718.6 | 1371.3 | 1564.1 | 2.2 | none | settled |
| warm_return_replies | 30 | 1561.9 | 1778.7 | 1362.1 | 1580.8 | 930.7 | stash_snapshot | settled |
| warm_return_tools | 30 | 307.0 | 318.4 | 271.6 | 286.6 | 134.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 258.3 | 275.9 | 228.8 | 246.6 | 48.7 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- end 530% (56% Screen; 49% WindowServer; 49% com.apple.WebKit.WebContent)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
