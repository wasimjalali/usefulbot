# Performance baseline, 2026-10-25 17:21 (092a205)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 684057ff6dfd), git 092a20582399, macOS 27.0.1, Apple M4.
Power AC, memory free 61%, load { 3.30 4.88 6.16 }, other work 159% CPU, web production.
Command: `perf/run.sh baseline`. Took 149 s.

| Case | n | Visual median | Visual worst | App median | App worst | Rows first paint median | Rows first paint worst | Rows done median | Rows done worst | Stall worst | Landed by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 786.8 | 879.3 | 632.4 | 726.8 | 69.3 | 104.4 | 69.4 | 106.7 | 66.0 | settled |
| cold_first_open_tools | 5 | 408.9 | 448.9 | 354.3 | 380.5 | 77.6 | 85.0 | 77.7 | 85.1 | 44.2 | settled |
| cold_launch | 10 | 1064.3 | 3081.8 | - | - | - | - | - | - | - | None |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Rows first paint: select to the first paint of the loaded rows. Rows done: select to the end of the row work.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_launch: cold-cold_first_open_tools-1: never landed
- cold_launch: cold-cold_first_open_tools-1: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_replies-1: never landed
- cold_launch: cold-cold_first_open_replies-1: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_tools-2: never landed
- cold_launch: cold-cold_first_open_tools-2: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_replies-2: never landed
- cold_launch: cold-cold_first_open_replies-2: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_tools-3: never landed
- cold_launch: cold-cold_first_open_tools-3: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_replies-3: never landed
- cold_launch: cold-cold_first_open_replies-3: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_tools-4: never landed
- cold_launch: cold-cold_first_open_tools-4: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_replies-4: never landed
- cold_launch: cold-cold_first_open_replies-4: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_tools-5: never landed
- cold_launch: cold-cold_first_open_tools-5: opened on , not Perf Short A
- cold_launch: cold-cold_first_open_replies-5: never landed
- cold_launch: cold-cold_first_open_replies-5: opened on , not Perf Short A

## Launch failures

- warm: the app aborted the scenario: step 0: Perf Long Tools never landed

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_tools-1 342% (48% syspolicyd; 40% WindowServer; 23% coreaudiod)
- cold-cold_first_open_replies-2 304% (41% WindowServer; 40% Brave; 26% (node))
