# Performance check, 2026-10-25 17:46 (092a205)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b72a03c5dfda), git 092a20582399 with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 68%, load { 4.52 5.80 5.38 }, other work 147% CPU, web production.
Command: `perf/run.sh check`. Took 552 s.

| Case | n | Visual median | Visual worst | App median | App worst | Rows first paint median | Rows first paint worst | Rows done median | Rows done worst | Stall worst | Landed by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 762.3 | 783.7 | 604.5 | 633.1 | 58.4 | 96.0 | 58.5 | 96.1 | 5.2 | settled |
| cold_first_open_tools | 5 | 375.4 | 411.1 | 331.3 | 365.4 | 62.0 | 103.2 | 62.1 | 103.2 | 3.9 | settled |
| cold_launch | 10 | 1032.1 | 1142.3 | 984.7 | 1012.2 | 741.0 | 767.7 | 741.1 | 767.7 | 3.3 | settled |
| warm_return_replies | 30 | 752.7 | 830.6 | 597.5 | 625.0 | 73.0 | 84.6 | 73.0 | 84.6 | 81.0 | settled |
| warm_return_tools | 30 | 397.7 | 507.6 | 346.3 | 370.0 | 73.9 | 97.3 | 74.5 | 97.4 | 50.0 | settled |
| warm_switch_short | 10 | 365.0 | 397.1 | 308.0 | 318.8 | 69.1 | 78.0 | 69.1 | 78.1 | 40.0 | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Rows first paint: select to the first paint of the loaded rows. Rows done: select to the end of the row work.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
