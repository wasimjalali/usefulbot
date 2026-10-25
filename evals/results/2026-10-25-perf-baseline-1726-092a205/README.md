# Performance baseline, 2026-10-25 17:26 (092a205)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b72a03c5dfda), git 092a20582399 with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 58%, load { 4.82 4.53 5.53 }, other work 175% CPU, web production.
Command: `perf/run.sh baseline`. Took 543 s.

| Case | n | Visual median | Visual worst | App median | App worst | Rows first paint median | Rows first paint worst | Rows done median | Rows done worst | Stall worst | Landed by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 775.5 | 850.8 | 615.7 | 699.0 | 56.8 | 120.4 | 56.9 | 120.5 | 5.7 | settled |
| cold_first_open_tools | 5 | 388.1 | 424.5 | 344.5 | 364.4 | 77.4 | 93.3 | 77.5 | 93.5 | 4.5 | settled |
| cold_launch | 10 | 1135.7 | 1168.5 | 1017.6 | 1081.2 | 772.7 | 840.5 | 772.7 | 840.5 | 3.3 | settled |
| warm_return_replies | 30 | 768.2 | 807.8 | 611.3 | 657.1 | 71.5 | 99.9 | 72.7 | 99.9 | 58.1 | settled |
| warm_return_tools | 30 | 395.7 | 481.1 | 343.0 | 368.0 | 67.7 | 89.9 | 67.8 | 89.9 | 42.3 | settled |
| warm_switch_short | 10 | 376.5 | 430.5 | 302.6 | 328.3 | 68.9 | 78.8 | 69.0 | 78.9 | 41.2 | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Rows first paint: select to the first paint of the loaded rows. Rows done: select to the end of the row work.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_launch: cold-cold_first_open_tools-1: opened on bf00af8c-5262-4227-a941-4c24d85eb474, not Perf Short A

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_replies-2 265% (61% Brave; 36% WindowServer; 26% node)
- cold-cold_first_open_replies-3 514% (50% mds; 41% mdworker_shared; 40% WindowServer)
- cold-cold_first_open_tools-4 598% (73% mds_stores; 54% mdworker_shared; 51% mdworker_shared)
- cold-cold_first_open_replies-4 626% (67% mdworker_shared; 62% mdworker_shared; 62% mdworker_shared)
- cold-cold_first_open_tools-5 598% (62% mdworker_shared; 58% mdworker_shared; 57% mdworker_shared)
- cold-cold_first_open_replies-5 686% (67% mds; 39% WindowServer; 31% mdworker_shared)
- warm 670% (92% Google; 59% Google; 37% mediaanalysisd)
- end 670% (96% Google; 46% cloudd; 42% Google)
