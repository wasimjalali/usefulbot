# Performance baseline, 2026-10-25 17:36 (092a205)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b72a03c5dfda), git 092a20582399 with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 60%, load { 4.72 4.42 5.02 }, other work 195% CPU, web production.
Command: `perf/run.sh baseline`. Took 552 s.

| Case | n | Visual median | Visual worst | App median | App worst | Rows first paint median | Rows first paint worst | Rows done median | Rows done worst | Stall worst | Landed by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 767.3 | 804.8 | 623.6 | 639.5 | 69.0 | 90.7 | 71.1 | 90.8 | 4.9 | settled |
| cold_first_open_tools | 5 | 408.3 | 448.4 | 345.6 | 359.4 | 66.9 | 79.2 | 66.9 | 79.3 | 3.2 | settled |
| cold_launch | 10 | 1109.9 | 1179.4 | 1007.1 | 1124.1 | 766.8 | 875.7 | 766.9 | 875.8 | 2.0 | settled |
| warm_return_replies | 30 | 774.9 | 911.6 | 617.6 | 756.0 | 67.4 | 114.2 | 67.5 | 117.1 | 69.3 | settled |
| warm_return_tools | 30 | 393.7 | 473.3 | 346.7 | 378.3 | 65.6 | 89.8 | 65.7 | 89.8 | 53.7 | settled |
| warm_switch_short | 10 | 355.5 | 454.9 | 311.1 | 319.9 | 74.3 | 81.9 | 74.7 | 82.0 | 37.1 | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Rows first paint: select to the first paint of the loaded rows. Rows done: select to the end of the row work.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- prep 258% (39% WindowServer; 27% Claude; 26% (node))
- cold-cold_first_open_replies-2 532% (206% Claude; 51% Claude; 42% WindowServer)
- cold-cold_first_open_tools-3 287% (44% WindowServer; 21% coreaudiod; 19% node)
- warm 715% (202% Claude; 106% Claude; 41% Google)
