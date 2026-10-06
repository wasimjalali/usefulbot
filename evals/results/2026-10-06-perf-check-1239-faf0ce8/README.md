# Performance check, 2026-10-06 12:39 (faf0ce8)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 f4f01075de65), git faf0ce8f8318, macOS 27.0.1, Apple M4.
Power AC, memory free 46%, load { 4.22 5.91 4.48 }, other work 119% CPU, web production.
Command: `perf/run.sh check`. Took 666 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 259.0 | 267.4 | 241.1 | 249.0 | 106.5 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 188.9 | 214.6 | 164.0 | 185.5 | 51.2 | disk_snapshot | settled |
| cold_launch | 10 | 892.1 | 1170.1 | 877.6 | 1145.8 | 2.1 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1467.0 | 1680.5 | 1308.8 | 1526.4 | 30.1 | none | settled |
| cold_no_snapshot_tools | 5 | 661.1 | 731.4 | 513.2 | 563.4 | 5.1 | none | settled |
| warm_return_replies | 30 | 232.4 | 258.9 | 211.5 | 224.4 | 139.2 | stash_snapshot | settled |
| warm_return_tools | 30 | 184.3 | 199.3 | 165.2 | 180.4 | 60.6 | stash_snapshot | settled |
| warm_switch_short | 10 | 196.8 | 204.9 | 172.3 | 188.2 | 2.6 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- prep 301% (42% syspolicyd; 39% WindowServer; 23% node)
- cold-cold_first_open_replies-4 553% (48% mdworker_shared; 46% mdworker_shared; 46% mdworker_shared)
- cold-cold_first_open_tools-5 584% (40% mdworker_shared; 40% mdworker_shared; 40% WindowServer)
- cold-cold_first_open_replies-5 572% (68% mds_stores; 42% mdworker_shared; 41% mdworker_shared)
- cold-cold_no_snapshot_tools-1 533% (51% mds; 50% mdworker_shared; 42% mdworker_shared)
- cold-cold_no_snapshot_replies-1 596% (51% mdworker_shared; 42% mds; 40% WindowServer)
- cold-cold_no_snapshot_tools-2 485% (355% mds_stores; 34% WindowServer; 13% Dock)
- cold-cold_no_snapshot_replies-5 256% (41% WindowServer; 26% UsageTrackingAgent; 24% node)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
