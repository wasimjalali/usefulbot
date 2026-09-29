# Snapshot key and sub-agent reports (PR 4, 2026-09-29)

## Questions

1. A long chat's first open after a rebuild or update took 9 to 11 s. Does keying chat snapshots
   to the replay logic, instead of to the binary, bring a rebuild's first open down to a
   same-build relaunch?
2. Do sub-agent reports ever show as the owner's bubble, and does the working row clear when two
   sub-agents report back together?

## What ran

- Mac: Apple M1, macOS 26.6, the installed `/Applications/Useful Bot.app`, services from this
  checkout. eve 0.54.3. Model: GPT-6-Luna (ChatGPT subscription), effort High.
- Chat measured: Generalist, the long chat the app opens on. Opening it sends nothing.
- Method (`coldopen.sh` here): quit the app, optionally `npm run install:app`, `open -g` the app,
  wait for its main window, record it with `winrec` at 60 fps for 16 s, and tile every changed
  frame with `framesheet`. The number is the frame time where the transcript paints, counted from
  the recording's start (the window's first frame).
- How the number is read: `framesheet` lists the frames where the picture changes; the chat
  time is the first frame whose tile shows the transcript instead of the loading mascot. Frames
  it picked, by run: before-run1 10812 ms, before-run2 10609 ms, before-samebuild 836 ms,
  B-firstlaunch 9242 ms, after-run1 845 ms, after-run2 707 ms, D-launch 10580 ms. The per-frame
  JPEGs (about 900 per run) were not kept; the tiled sheets here show each picked frame. Rerun:
  `coldopen.sh <outDir> [install]`, then `framesheet <outDir>/frames sheet.jpg`.
- The chat times start at the window's first frame. Launch to that frame took another 1.3 to
  2.3 s in every run (`*-timing.txt`), the same before and after. `coldopen.sh` assumes this
  checkout at `~/Desktop/useful-bot`.
- Before: `main` at `b483a2f`, snapshots keyed to the binary's size and modification time.
- After: snapshots keyed to `ChatSnapshot.formatVersion` plus a hash of the `UsefulBotCore`
  sources, stamped into Info.plist by `macos/build-app.sh` (`UBSnapshotLogic`).
- Cost: no model spend for question 1. Question 2 used four Test Bot turns on the ChatGPT
  subscription.

## Numbers

| Case | Build | Chat painted |
|---|---|---|
| Rebuild, first launch (run 1) | before | 10.8 s (`before-run1.jpg`) |
| Rebuild, first launch (run 2) | before | 10.6 s (`before-run2.jpg`) |
| Same build relaunched (control) | before | 0.84 s (`before-samebuild.jpg`) |
| First launch of the new key scheme | after | 9.2 s, once, expected (`B-firstlaunch.jpg`) |
| Rebuild, Core unchanged (run 1) | after | 0.85 s (`after-run1.jpg`) |
| Rebuild, Core unchanged (run 2) | after | 0.71 s (`after-run2.jpg`) |
| Rebuild, Core changed (the report fix) | after | 10.6 s, once, expected (`D-launch.jpg`) |

A rebuild that leaves `UsefulBotCore` alone now opens as fast as a same-build relaunch. A build
that changes it replays each chat once, which is the guard the binary key gave, now paid only
when the replay logic can actually have changed.

## Sub-agent reports

- eve 0.54 marks every message it sends into a session for a background task as
  `execution.background_task`, then drops the mark on the streamed `message.received`.
  `scripts/patch-eve.mjs` (postinstall) forwards it as `data.kind`, and the app hides any message
  carrying it. Old streams still go by eve's wording, as before.
- Only a background tool or a workflow tool sends unprefixed text; the `agent` sub-agent tool
  always uses eve's "Background task ..." wording, and this agent has no background tools. So the
  unprefixed case could not be reproduced here; the mark covers it when one is added.
- Found live instead: the owner's own Generalist turn ("launch 2 sub agents") left
  "Sub-agent working 6m 28s" under the final answer (`generalist-bottom-stuck-row.jpg`). eve hands
  reports that land together to one turn, joined by a blank line, and the app settled only the
  first task id. It now settles every report in the message. After that build replayed the chat,
  the row was gone (`generalist-bottom-fixed.jpg`).
- Test Bot, 60 fps through the turn (`tb-run1.jpg`): two parallel sub-agents, no owner bubble
  for either report in any frame, the working row cleared, the combined answer landed. Same after
  a relaunch (`testbot-after-relaunch.png`).

## Later the same day

Review round 1 found that `AppModel.swift` also shapes what a snapshot stores (the resume
follower, the replay swap, the prewarm builder), so the key now hashes it too. It changed in
about a quarter of recent commits, so more updates will replay each chat once than the table
above suggests. That is the safe direction; it is noted here so a later perf check on "first
open after update" isn't a surprise.

## What changed because of it

- `AppModel.snapshotKey`, the Info.plist stamp in `build-app.sh`, the `ChatSnapshot.build` doc.
- `EveStream.taskReports` and the `kind` check in `StreamProjection`.
- `scripts/patch-eve.mjs`, run on every install and shipped in the release runtime.
