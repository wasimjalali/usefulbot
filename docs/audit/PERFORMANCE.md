# Performance record

What made the macOS app slow, what was changed, and what it bought. Newest batch first.
Every number here was measured on the owner's machine; nothing is an estimate unless it says so.

The gains below are guarded by `npm run perf:check` (see `perf/README.md`) since 2026-09-26.

## How the audit ran (2026-09-17)

Five models read the code against the same read-only brief, then each finding was checked by
hand against the source and against a live `sample` of the running app before anything was
changed.

| Auditor | How it ran | Round 1 findings |
|---|---|---|
| GPT-6 Astra | Codex, xhigh effort, three rounds on one session | 18, plus 5 new in round 2 and the risk-ordered plan |
| Muse Spark 1.3 contributor | opencode, `--variant max`, rounds 1 and 3 | 20 |
| GLM 5.3 flash | opencode, `--variant max`, rounds 1 and 3 | 20 |
| DeepSeek V4.1 flash | opencode, `--variant max` | 16 |
| HY4 preview | opencode, `--variant max` | 18 |

Round 2 asked Astra to judge what only the other models had found and to trace the main actor
for a keystroke, a streamed delta, an idle poll and a chat switch. Round 3 was a trap review of
the fix plan before any code was written (Spark and GLM answered it; Astra's copy ran out of
workspace credits once and was rerun).

## How to measure

- Idle CPU: `top -l 31 -s 1 -pid <pid> -stats pid,cpu,mem`, drop the first sample, average the rest.
  Let the app settle for 20 s after launch first.
- Where the time goes: `sample <pid> 5` and read "Sort by top of stack".
- Chat open, frame by frame (since batch 10): record the window at 30 fps with
  `winrec <windowId> <seconds> <dir> 30` while rail rows are clicked in the background through
  `cua-driver` (`element_token`, never the real pointer). A clip is only written when the window
  changes, so the time from the first changed frame after a click to the last changed frame before
  the next click is click-to-final-frame. Diff only the chat column (leave out the rail and the
  header) and look at every frame in the gap: a mascot, a blank or a jump shows up there and
  nowhere else. The AX click reaches the app 2 to 3 s after `cua-driver` is called, so time from
  the first changed frame, not from the call.
- The clicks go through Accessibility, which switches on SwiftUI's accessibility tree for the app.
  That makes every row build slower than it is for someone using a mouse, the same on both sides
  of a comparison. A locked screen hides every window from Accessibility, so the recorder has to
  run while the screen is unlocked.
- Service cost: `ps -axo pid,rss,%cpu,command | grep -E 'next-server|eve'`.
- Memory: `footprint <pid>` for the total and the per-category table (a big "CG image" line is a
  bitmap someone drew too large; `vmmap -v <pid> | grep '^CG image'` lists the regions). To find who
  allocated a region, launch the debug binary with `MallocStackLogging=1` and run
  `malloc_history <pid> <region start>`. The production web server logs no per-request lines, so
  chat-open is now timed by `ps -o %cpu` per second after the click until it settles.

## Batch 11: the transcript knows where its bottom is again (PR: fix/reply-follow-after-tool)

Measured 2026-09-25 on the installed app with a temporary file trace of the scroll geometry and
the landing loops (removed before merge), Test Bot open:

| Measure | Before (main @ c66d716) | After |
|---|---|---|
| Cold start, landing at the newest turn | 10,037 ms (hit the 10 s `landingCap`) | 592 ms and 621 ms |
| Chat switch landing (Generalist, back to Test Bot) | not measured before | 870 ms and 446 ms |
| Reply after a tool step | landed with its end under the composer; pin dropped 240 ms after the send | followed to the bottom, pin held for the whole turn |

- **Problem.** Since the floating header became a top safe-area inset (#123), the pin tracker
  computed the bottom edge as `contentOffset.y + containerSize.height - contentInsets.bottom`.
  With the 62 pt top inset that put the true bottom 62 pt short: at rest the distance read 62,
  never 0. The landing loops wait for `distance <= 1`, so every cold landing ran to the 10 s cap,
  and a 24 pt clamp after a send (the scroll-to-bottom landed on a height from before a shrink)
  read as the reader scrolling up, unpinned the view, and left the reply below the fold.
- **Fix.** The bottom edge is `visibleRect.maxY - contentInsets.bottom`, what is actually on
  screen. One line in `ScrollPinnedTracker`.
- **Checked.** 30 fps recordings of a tool-step turn, a cold start and a chat switch, every
  changed frame reviewed: the reply follows, the cold start shows the newest turn at 0.93 s and
  stays still, the switch lands at the newest turn.

## Batch 10: chats open from a snapshot (PR #118, perf/instant-chat-open)

Measured end to end, from the moment the app handles the switch to the last frame that changes.
Both builds carried a temporary hook (never committed) that selects a chat by name when a
distributed notification arrives, so no Accessibility client was involved; the app's own log
timed select to landing and a 30 fps recording gave the final frame and the visual check. Same
machine, same sessions, same sequence: cold launch, then Test Bot, Generalist, Test Bot,
Generalist, YT Producer, Test Bot, YT Producer. "First open" is the first open of that chat after
the launch.

| Case (events in the session) | Before (main @ 9465724) | After |
|---|---|---|
| Launch, window to first chat (Job Scout, 749) | 1.48 s | 0.67 s |
| First open, Test Bot (7,659) | 4.57 s | 0.32 s |
| First open, Generalist (10,794) | 4.70 s | 0.47 s |
| First open, YT Producer (12,554) | 6.35 s | 0.45 s |
| Switch back, Test Bot | 0.69 to 0.70 s | 0.36 s |
| Switch back, Generalist | 0.95 s | 0.42 s |
| Switch back, YT Producer | 0.82 s | 0.37 s |
| eve CPU for one YT Producer open | 4.8 s | none when nothing is new; one chunk file per new event |

- **A number that was wrong, caught.** The first "after" run timed from the first frame that
  changed after an Accessibility click and read 0.02 to 0.09 s. That clock starts only after the
  main thread has built the new chat, about 300 ms after the click is handled, and Accessibility
  makes that build slower still. The before numbers had the same blind spot. The table above is
  the end-to-end measure; the frame recordings are kept for what they are good at, showing that no
  mascot, blank or jump appears.
- **What is left: SwiftUI building the rows.** With the data work gone, a switch back is about
  300 ms of SwiftUI creating the transcript's views (text layout, one text-selection view per
  text, view graph setup; `sample` on a switch with no Accessibility client). Under 100 ms needs
  chats kept mounted across switches, so a switch shows a view that already exists. Proposed as
  the next step, not done here.
- **Where the time went.** Chat turns live only in the eve session, so every first open replayed
  it from event 0. eve's local world opens every chunk file of the session before it sends a byte
  when asked for the tail index (1.25 s for YT Producer's 12,554 files, measured in isolation),
  then reads every file again for the replay (another 1.2 s), then the app decoded all 12,554
  events (373 ms in a debug build) and applied them. One YT Producer open cost eve 4.8 CPU seconds
  and the app 6.2. A switch back to a chat opened earlier replayed the whole session again behind
  its cached rows, and its landing waited out three 50 ms geometry checks and a 0.15 s fade: 0.35 s
  before anything else.
- **Fix 1: a snapshot per chat.** `ChatSnapshot` (UsefulBotCore) is the chat's full projection,
  its durable rows, the event cursor, the id of the event before the cursor and the turn-id sets,
  written to `~/Library/Caches/UsefulBot/chat-snapshots/<bot>.json` (0600) whenever the chat comes
  to rest: a load finishing, a turn ending, the owner switching away. Only a chat at rest is saved,
  and only a projection read from one session, so a snapshot is always exactly what a replay from
  zero would have built at its cursor. YT Producer's is 164 KB and decodes in about a millisecond.
- **Fix 2: read on from the cursor.** An open restores the snapshot in the same pass that selects
  the chat, then reads only the events recorded after the cursor. When the session's newest event
  is the one the snapshot ended on, it reads nothing at all.
- **Fix 3: no tail index.** eve documents a negative `startIndex` as relative to the tail; a read
  at `-1` opens one chunk file and names the newest event. Everything up to that event is history,
  so the load reads to it and stops, and eve never scans the session. A chat with no snapshot yet
  still replays from zero, 1.25 s sooner on a YT Producer sized chat.
- **Fix 4: prebuilt snapshots.** Three seconds after launch the app builds the snapshot of every
  chat that has none, one at a time and off the main thread. All seven chats here had one within
  45 s of the first launch; every later first open is a restore.
- **Fix 5: land at once.** A restored chat skips the mascot and the fade and lands as soon as its
  reload confirms the rows (about 70 ms: a durable read and a one-file probe) and layout reads the
  true bottom at one height on two frames in a row, checked every frame. A chat that gained a turn
  while the app was closed opens on that turn instead of showing it arrive; if the confirmation
  takes over 0.6 s the mascot comes back until it does.
- **Fix 6: the newest rows first.** With the replay gone, building the transcript's views was most
  of what was left (Generalist mounts 60 blocks, 8,669 points tall). A
  restored chat mounts the newest 14 blocks (the newest turn always whole) for its first frame and
  the rest of the window two frames after it has landed, above the fold, where the bottom anchor
  keeps the rows on screen still. If the newest rows do not fill the window, the rest mounts before
  anything is shown, or the short column would sit at the top and then drop.
- **Two open items from PR 117, closed.** A reader scrolled up into the history no longer moves when
  a reply grows below them: the bottom anchor now applies to size changes only while the reader is
  at the newest turn (macOS 15 and later). And a chat left before its first replay finished, with a
  send still running, no longer lands on the partial rows when the owner comes back: the send only
  counts toward landing when it was made in this visit, and the reload does not mark a partial
  history loaded.
- **How it is kept honest.** `ChatSnapshotTests` applies a session to a projection, round-trips it
  through the snapshot, reads on from the cursor and requires the result to equal a replay from
  zero, private state included. It also pins the projection's stored property names to
  `ChatSnapshot.formatVersion`: adding a property fails the test until the version is bumped, and a
  snapshot of another version or build, or older than a week, is never restored. `HistoryMarkerTests` pins the marker read (no tail
  index asked for, history ends at the marker, a read that ends before it throws). A resume that
  never reaches its marker falls back to a replay from zero.
- **Found in review (Opus 5.5, high effort, four passes).** Pass 1: a snapshot could be taken
  mid in-place reload with the cursor rewound under the old projection (high), and a restored chat
  landed at 150 ms whether or not its reload had confirmed the rows (high); plus eleven lows (the
  probe never re-signed in, damaged files could crash, files outlived New Chat and deletes, and
  others). Pass 2: rows restored from the in-memory stash waited for a full replay where main
  showed them at once (high); the resume read could never end if a snapshot sat past the end of
  its session, so it now starts one event early and checks that event is the one the snapshot
  ended on. Pass 3: a snapshot never healed a later fix to the fold logic (high), so snapshots are
  now tied to the app build and last at most a week, and a projection holding a turn painted by a
  local send is never saved. Pass 4: no critical or high findings; its four lows are listed in the
  PR (a rebuild makes the prewarm replay every chat once, a send in the first ~70 ms of an open,
  events without `meta.at`, a purged cache directory mid-run).

## Batch 9: the tick sweeps orphans once a minute (PR: perf/server-stores)

Measured in-process with a node harness importing the same functions the routes call (scratchpad
`storebench.mts`), against the real files: `shell.json` 12 KB, `agents.json` 42 KB, one widget:

| Call | Cost | Cadence before | Cadence after |
|---|---|---|---|
| `sweepOrphanState()` | 6,069 us | every tick, 2.5 s (145 ms of event loop a minute) | once a minute (6 ms) |
| `readShell()` | 47 us | every shell poll | unchanged |
| `readAgentStore()` | 123 us | every state poll, twice per tick | unchanged |
| `listThreadEvents()` | 152 us | every state poll | unchanged |

- **Problem.** Every tick swept routines, threads, widgets and the handoffs directory for bots the
  roster no longer has. The sweep is maintenance: it only shortens how long a leftover from a
  failed delete can linger, and it cost more than everything else the tick reads put together.
- **Fix.** `sweepOrphanStateIfDue` runs it at most once per minute, the first tick after a start
  included. The route calls it where it did (after authorisation and the rate limit, before the
  credential gate). Direct deletion still cleans up at its own call sites; a leftover can now
  linger a minute instead of a tick, which is the trade Astra (T-14) and GLM (T-10) both priced.
- **Looked at and not done: the parsed-store memo.** The audit proposed caching the parsed shell
  and agent stores by file identity. On this machine's files a read is 47 to 123 microseconds, so
  the memo would save under a millisecond a poll, and it changes who owns the returned object
  (Astra's T-13): `withAgentStore` clones what it reads, other callers do not. Not worth the risk
  for the number; revisit if `agents.json` ever reaches megabytes.
- **The trap we hit.** The throttle's "never swept" state was 0, and the test's fake clock of
  1,000 ms sat inside the first minute of it: the first call did not sweep. A null sentinel.
- **Found in review (Muse Spark).** Nothing on the first pass.
- **Caught by.** GLM, DeepSeek, HY4, Spark filed the per-tick sweep; GLM and DeepSeek the store
  parses (measured, declined).

## Batch 8: the per-bot caches have a byte budget (PR: perf/cache-budget)

Measured on the debug build with four chats visited, logging the estimate the budget works from:

| Measure | Before (main @ 62a7a95) | After |
|---|---|---|
| Bytes held by `transcriptCache` and `backgroundProjections` for four chats | 453 KB, kept for the life of the app | 453 KB, under a 16 MB budget that never triggers here |
| App footprint after visiting every chat | 101 MB | 101 MB |

- **Problem.** Every chat visited stayed cached (rows, blocks, durable events and the stashed stream
  projection with its 2,000-id dedupe ring) until the app quit. Bounded by the roster, but the
  roster is not bounded.
- **Fix.** `CacheBudget.evictions` (Core, tested) names the least recently used bots to drop until
  the estimate fits 16 MB. `trimCaches()` runs after every stash. A bot is never evicted while it is
  the open chat, holds a send this app started, or is working in the background (a handoff, a
  routine, a turn the follower is painting into its stash), and a background bot's last use is
  touched by every live event it receives, so a fresh unread reply is not the first to go.
- **What it bought today: nothing.** A chat here is about 100 KB, so the budget is room for well
  over a hundred of them. It is the bound Astra, Spark and DeepSeek asked for, and the estimate is
  logged nowhere, so the number above came from a temporary line that was removed again.
- **Found in review (Muse Spark).** Nothing on the first pass.
- **Caught by.** Astra, Spark, DeepSeek.

## Batch 7: a drawing's web view is created when its box comes near the window (PR: perf/widget-views)

Measured on the Storyboard Artist chat, which holds one Excalidraw drawing above its newest turn,
counting the WebKit helper processes (`WebContent`, `GPU`, `Networking`) and their resident size:

| State | Before (main @ d9c5421) | After |
|---|---|---|
| Chat opened at its newest turn, drawing off screen, 780 pt window (debug build) | 7 WebKit processes, 135 MB, one `WebContent` at 79 MB | 4 processes, 6 MB (the ones every app with WebKit linked already has) |
| Same, 1,011 pt window (installed): the box is inside the 800 pt margin, so it is created at open | 135 MB | 7 processes, 36 MB until scrolled to, 60 MB once painted |
| Scrolled up to the drawing | the same 7 | 7 processes, 60 to 151 MB, drawing rendered |
| App footprint | 76 MB | 63 to 74 MB (the processes are separate) |

- **Problem.** `TranscriptRowView` mounted a `WKWebView` for every widget row as soon as the chat
  opened, and a chat opens at its newest turn, so every drawing in the history started its content,
  GPU and networking processes for nothing on screen. The fetch task of a row that left (a chat
  switch) was cancelled by the coordinator's `deinit` only when SwiftUI released it.
- **Fix.** `WidgetSlot` keeps the row's 480 pt box and creates the web view once the box comes
  within 800 pt of the scroll view's visible bounds (`onGeometryChange` against
  `bounds(of: .scrollView)`, macOS 15; on macOS 14 it mounts eagerly as before). Once created it
  stays until the row leaves, so scrolling past a drawing twice does not load it twice, and there is
  no reuse cache to grow. `dismantleNSView` cancels the fetch, stops the load and drops the delegate.
- **The trap we hit.** The first lazy build showed the page's header and a blank drawing. The host
  page's iframe is `width: 100%`, and a web view created mid-scroll loaded its page before SwiftUI
  had given it a width; the drawing laid itself out at zero and stayed there. The fetch now starts on
  the view's first non-zero `setFrameSize`. The mid-scroll sequence was re-run twice after, and a
  drawing already in range when a chat opens was checked by setting the margin to 100,000 pt for one
  run: the initial geometry value is delivered.
- **Found in review (Muse Spark).** Nothing on the first pass.
- **Caught by.** All five models filed the eager `WKWebView`; Astra's P-2 set the order (fixed
  height, cancel on dismantle, test a revisit before any reuse cache, never an unbounded one).

## Batch 6: a streaming reply parses into one slot (PR: perf/streaming-markdown-cache)

Measured with a throwaway harness linking `UsefulBotCore` (scratchpad `mdprobe`), streaming a 1.1 KB
reply with headings, two lists, a table and a quote, then rendering the final text once, the way the
transcript does when the turn ends:

| Delta size | Shared cache entries left after one reply, before | After |
|---|---|---|
| 24 characters (46 deltas) | 111 | 27 (the final text's own blocks and spans) |
| 4 characters (272 deltas, closer to tokens) | 529 | 27 |
| Parse time for the whole stream | 15 to 39 ms | 14 to 23 ms |

- **Problem.** `ChatMarkdownCache` keys on the text, so every delta of a growing reply was a new
  entry in both the block cache and the inline cache, and stayed there: at 529 per reply, four
  replies pushed every stable row of the transcript out of a 2,048-entry FIFO, and each of those rows
  then parsed again on its next render.
- **Fix.** A `Transient` store, one replaceable entry per streaming row (keyed by row id, eight rows
  at most), holds the current text's blocks and the inline spans of the current and previous delta,
  so a paragraph that did not change is carried over while the one after it grows. `ChatView` marks
  a row streaming while a turn runs and the row is in the newest reply run; the flag is part of the
  row's equality, so the turn ending re-renders the row once through the shared cache even when no
  delta follows (Astra's T-16). Nothing else changes: a row that is not streaming reads the shared
  cache as before.
- **Not measured live.** A real stream would mean sending a turn into one of the owner's chats;
  the harness runs the same `ChatMarkdownCache` code the view calls.
- **Found in review (Muse Spark).** Nothing on the first pass.
- **Caught by.** Astra (P-8, and T-16 on the lifecycle), Spark, GLM. Spark's round 3 named both
  layers: fixing only the block cache would have left the inline prefixes accumulating.

## Batch 5: a cached chat switch builds once, and long chats mount a window (PR: perf/windowed-transcript)

Measured as CPU seconds the app spent in the six seconds after a rail click (`ps -o cputime`
before and after, all threads), both chats already opened once in the session so the switch comes
back through the transcript cache, both on the installed build:

| Switch to | Before (main @ 5059b1a) | After |
|---|---|---|
| Generalist (34 rows) | 1.03 to 1.08 s | 0.87 to 0.93 s |
| Drive Admin (36 rows, 3,504 events) | 1.92 to 1.96 s | 1.51 to 1.53 s |
| Publishes per cached switch | 2 with different rows, then 2 equal | 1, then 3 skipped |
| Footprint | 124 MB | 104 MB |

- **A false number, caught.** The first "after" read 0.04 s per switch. The debug build's window
  opens at its own saved frame, and the rail clicks aimed at the installed app's frame landed in the
  transcript, so nothing switched. The rule from batch 1 applies to inputs as much as fixes: read the
  window frame before every measurement.
- **Problem.** A switch back restored the stashed projection and rebuilt at once, but `resetThread`
  had already cleared the durable events, so that first build was the projection alone (30 rows),
  published and laid out; the reload then published the full merge (34 rows) and laid it out again;
  two more rebuilds followed and published the same rows a third and fourth time. Separately, every
  replayed event's stamp went through `ISO8601DateFormatter`, which is ICU: 250 ms of the 3,504
  event replay in `sample`.
- **Fix.** `transcriptCache` carries the durable events, and a cached switch restores them before
  its first rebuild, so that build is the full merge. `rebuildTranscript` assigns `transcript` and
  `transcriptBlocks` only when either differs from what is published (both compared: a day label
  moves at midnight with no row changing), and `searchHits` on change. The reload's publish and the
  poll's now compare equal and assign nothing. `TranscriptBlocks.date(fromISO8601:)` reads the
  server's exact `toISOString()` shape by hand (days from the civil date, no calendar) and leaves
  anything else to the formatters; pinned against the formatter across leap days, fractions and the
  epoch.
- **What is left, per `sample`.** About 0.5 s of SwiftUI creating and laying out 34 rows (view graph
  and `_FlexFrameLayout`, text measurement is under 70 ms of it), and for Drive Admin the replay's
  JSON decode on the stream's thread, which is the deferred cursor-resume item.
- **Windowed transcript.** `TranscriptBlocks.window` mounts the newest 60 blocks and a "Show earlier
  messages" row above them. The newest turn is always whole (the reply's height is summed from
  every bubble and the completion scroll targets its first), the window opens under the day
  divider its first row belongs to, never on a summary strip, and it never slides: the first block
  is held per bot as the chat grows, so a row being read is not pulled away. The stack stays an
  eager `VStack`, as Spark and GLM advised. Expanding re-anchors the block that was first, without
  animation, because a prepend leaves the scroll offset at the top of the new rows (seen live).
- **What the window bought today: nothing measurable.** Neither chat on this machine has 60
  blocks; Drive Admin's 3,504 events are almost all tool activity. The row, the expansion, the held
  place and the row leaving at the top were verified live on a build with the minimum set to 10,
  then restored. The window is insurance for the chat that does grow, bounded work either way.
- **Found in review (Muse Spark).** Expanding to the top held the chat's leading day divider, which
  the window then stepped past, so one block stayed "hidden" and the row never left (high): a window
  with no message above its cut is now the whole chat. The re-anchor id was kept after use, so a
  later shrink of the hidden count (a cleared session) would have scrolled to it (medium): it is
  taken once. The first mounted bubble kept the tight gap it has under a bubble that was now behind
  the row (low). All three fixed; the first is pinned by a test and was checked live. On the
  second slice: a cached-only switch left the events empty, so a second quick switch would have
  stashed the rows with no events (medium), and the hand parser rolled an impossible day such as
  February 30 into March instead of leaving it to the formatters (medium). Both fixed, the parser
  pinned against a list of impossible stamps.
- **Caught by.** All five models filed the history-scaled layout; Spark and GLM set the window over
  `LazyVStack`, GLM named the prepend jump and the seam identity, Astra (T-17) the cut-off reply. The
  no-change publish skip was agreed as the cheap piece of Astra's P-1. The double publish on a
  cached switch and the ICU stamp parse came out of `sample` while measuring, not from the audit.

## Batch 4: the app icon was a 278 MB bitmap (PR: perf/brand-rasters)

Measured with `footprint <pid>` on the installed app, settled 25 s after launch, Generalist open:

| Measure | Before (main @ a1c7709) | After |
|---|---|---|
| Footprint, fresh launch | 352 MB, of which "CG image" 266 MB in one region | 124 MB installed (98 MB as a debug build), "CG image" 14 MB |
| Footprint with the 3,504 event Drive Admin chat open | 379 MB | 124 MB |
| Footprint after 10 h 44 min | 661 MB, "CG image" 532 MB (two of the same region), peak 1.1 GB | not yet measured over a day; the second copy came from the same icon refresh, so it is gone with it |
| ImageIO (decoded PNGs) | 29 MB, the eight 1024 px motion layers | 1.3 MB |
| Idle CPU | 0.6% | 0.7% average, 2.9% peak over 30 s |

- **Problem.** Every PNG under `brand/` carries 25 dpi metadata, the iconset inside
  `UsefulBot.icns` included, so `NSImage` reported a 1024 px bitmap as 2,949 pt.
  `NSApp.applicationIconImage = BrandAssets.image("app/macos/UsefulBot.icns")` in `RootView` made
  AppKit snapshot the icon at its point size times the 2x backing scale: a 5,898 px RGBA half-float
  bitmap, 278 MB, allocated under `-[NSApplication _updateIconImageFromOriginal]`, and again on the
  next icon refresh, which is where the second copy came from. The audit had this filed as "30 fps
  avatar timelines with 1024 px layers" because the layers share the metadata; the splash decoded all
  eight at 1024 px for a 168 pt view, but that was the 29 MB of ImageIO, not the 532 MB.
- **How it was found.** `footprint` put 532 of 661 MB under "CG image" in four 128 MB regions plus
  two of 9.5 MB. `lldb` dumped one region; the pixel values were half floats, the row autocorrelation
  gave a width of 5,900 px, and the rendered dump was the mascot's body. `MallocStackLogging=1` plus
  `malloc_history <pid> <address>` on the debug build gave the allocating frame.
- **Fix.** `BrandAssets.image` sets the point size of any all-bitmap brand image to its largest
  representation's pixels divided by two: a brand bitmap is a 2x asset. SVGs keep their own size.
  Motion layers are rasterised once per drawn size (`BrandAssets.motionLayer`, a `size x 2` px
  bitmap, scaled up by the avatar crop and the working row's breath so it stays 1:1 on screen)
  instead of handing the 1024 px source to eight `Image` views 30 times a second. The working row
  draws `BrandMotionFrameView` from its own timeline; it used to nest a `BrandMotionView` with a
  second 30 fps timeline inside the first.
- **Not done.** The PNGs keep their metadata. Rewriting `brand/` touches tracked assets, the manifest
  and the web build for no gain the loader does not already give.
- **Found in review (Muse Spark).** The avatar path scales the layer stack by 1024/768 after layout,
  so a 28 pt raster was drawn at 37 pt and went soft. The raster now takes that scale, and the 1.04
  breath, into its pixel count.
- **Caught by.** All five models filed the 1024 px layers and the nested timeline (open item 7). None
  found the icon; the footprint did.

## Batch 3: a send stops replaying the session before its reply (PR: perf/send-cursor)

Measured through the app's own `BackendClient` against the live server, on the 3,504 event
Drive Admin session, three rounds, nothing posted:

| Work in front of the first token of every reply | Before | After |
|---|---|---|
| Turn id snapshot | 1,032 to 1,178 ms, 3,504 events, 1.1 MB | 392 to 397 ms, 0 events |
| Send stream walking history to reach its own turn | 1,030 to 1,059 ms, 3,504 events | none, it starts at the tail |
| Total | 2.07 to 2.21 s | 0.39 to 0.40 s |

- **Problem.** `send()` read the session from event zero to collect the turn ids on record,
  posted the turn, then opened its reply stream from event zero again and skipped forward until
  it met its own message. Two full replays, decoded line by line, before a single token, growing
  with every message in the chat.
- **Fix.** `BackendClient.historySnapshot` returns the turn ids and `nextIndex`, one past the
  tail the server reported (`x-eve-stream-tail-index`). It reads only past the follower's cursor
  when the follower holds this session. The send's stream starts at `nextIndex`.
- **Why the reply cannot be missed.** The cursor is taken before the turn is posted, so the new
  turn's first event sits at or after it. The server's tail is the only authority: an earlier
  draft used `max(tail + 1, cursor)`, which would have started past the new turn had a cursor
  ever run ahead of the record, and the reply would never have armed.
- **Why it cannot arm on the wrong turn.** Old turns are behind the cursor and are never read,
  and the turn id check stays in place. Proven live: four real turns with identical text on one
  session each armed on their own new turn (`turn_0` at index 2, `turn_1` at 18, `turn_2` at 26,
  `turn_3` at 34), including one through the old from-zero path for comparison.
- **No tail header, no change.** `nextIndex` is nil, the stream reads from zero and the snapshot
  is retaken from zero so its turn ids cover the whole session. The app remembers that and reads
  from zero directly afterwards.
- **Found in review (Muse Spark).** The follower reads live events past the recorded tail, so its
  cursor can sit ahead of it; a short snapshot then returns no ids for the very stretch the send
  reads. And the stream's tolerance for an untagged message fires when the id set is empty, which
  used to mean "this session tags nothing" and had become true on nearly every send. The app now
  keeps every turn id it has read per session (`seenTurnIds`), unions it into the snapshot, uses
  the short read only for sessions known to tag their turns, and shuts the untagged arm for them.
  Any other session gets the old full read.
- **Accepted, not fixed.** A session truncated under the same id in the instant between the
  snapshot and the POST would leave the stream waiting past the new turn until the 20 s unarmed
  watchdog reports that the turn did not start. eve retires an id on reset rather than reusing
  it, so this needs a storage fault inside a window of milliseconds.
- **What is left.** About 0.4 s of that is eve opening any stream at all, measured the same with
  nothing to read and through the proxy, so it is eve's cost, not the app's.
- **Caught by.** All five models. Astra (A-04) named the fix, a cursor returned with the
  snapshot, and warned to capture it before the POST and to keep the turn matching.

## Batch 2: the web service runs a production build (PR: perf/production-services)

| Measure | Before (`next dev`) | After (standalone build) |
|---|---|---|
| Web server memory | 268 MB after 12 h, 166 MB earlier the same day, plus a postcss worker | 114 MB fresh, 131 MB with the app attached |
| Web service ready after its launcher starts | route compiled on its first hit, "tens of seconds" cold | "Ready in 0ms"; healthy 2.6 s after the app launches, launcher and keychain included |
| `/api/shell`, `/api/providers`, `/api/approvals`, `/api/agent/state` | 6 to 40 ms average from the dev log, 1,184 ms worst case logged for `/api/providers` | 4 to 5 ms each |
| Replay of the 3,504 event session through the `/eve` proxy | 1,524 ms logged | 1,128 ms, all 3,504 events, tail header intact |

- **Problem.** `scripts/service.mjs` started the installed app's web service with `next dev`:
  a compiler, file watchers and a postcss worker on the request path of every poll and stream,
  and the largest process in the stack.
- **Fix.** `npm run build:app` now runs `next build web`, copies `static` and `public` into the
  standalone output (Next leaves that to the caller) and stamps the build with a SHA-256 of its
  sources. `scripts/web-mode.mjs` decides how the service runs: the built server while the
  sources (`web/`, `shared/`, `agent/`, `router/src`, `brand/source`, `package.json`) still hash
  to that stamp, otherwise `next dev`. The launcher logs one line saying which and why.
  `UB_WEB_MODE=dev` forces the dev server. The check costs 0.17 s at launch.
- **Why a fallback and not a hard failure.** This checkout is both where the code is edited and
  what the installed app runs. A stale build would serve old routes against new shared code, and
  a launcher that refused to start would take chat down for an edit. The dev server is always
  correct, just heavier, so an edit costs memory until the next `build:app`, never correctness.
- **The lockfile is not a freshness input.** eve restamps `package-lock.json` on its first boot,
  which would mark every build stale the moment the services came up.
- **The trap we hit.** Next does not recognise TypeScript 7 as `typescript` and runs
  `npm install typescript` on every build. It installs nothing, but npm rewrote
  `package-lock.json`, and the router refuses a lockfile whose hash changed: 42 tests failed with
  "package-lock hash mismatch" and the router would have refused to boot after the next
  `build:app`. The build now runs with `npm_config_package_lock=false npm_config_save=false`.
  `NEXT_IGNORE_INCORRECT_LOCKFILE` does not cover this path.
- **Found in review (Muse Spark).** The first version compared modified times and missed
  `brand/source` (the avatar palette `shared/bot-face.ts` imports) and `package.json`; a restored
  backup with old times would have served a stale build. Hence contents, not times. Also from
  that review: node is looked up in both supported install paths, a freshness check that throws
  falls back to the dev server, and `/api/status` gets the app version from the launcher because
  the traced copy has no `package.json` beside it. One finding was rejected: the supervisor does
  recognise the renamed `next-server`, through its `service.mjs` parent, as it did for `next dev`.
- **eve stays on `eve dev`, on purpose.** Measured at 20 MB and 0% CPU idle, so there is nothing
  to win, and `eve start` changes the auth policy, port defaults and build output the rest of the
  stack depends on.
- **Supervisor.** `ServiceSupervisor.isOwnNodeProcess` recognises the built server's command line
  on the same path-boundary rule as the others, so a sibling checkout is still never signalled.
- **Verified.** Through the web UI's own session on the production server: the four poll routes
  and a full stream read of the long session. macOS app relaunched against it and rendered.
- **Caught by.** All five models reported `next dev`. Spark and GLM established that
  `web/.next/standalone` was a stale manual build that `build:app` never refreshed; Astra
  confirmed the dates. Astra, Spark and GLM all advised against treating eve the same way
  without checking its auth and data directory, which is why eve was measured first.

## Batch 1: idle and render invalidation (PR: perf/idle-and-render-batch-1)

Test chat: Drive Admin, one eve session of 3,504 events, with markdown tables in its history.

| Measure | Before (main @ cb0ceba) | After |
|---|---|---|
| Idle CPU, no turn running | 29.2% average, 69.5% peak, window not even on screen | 0.6% average, window visible |
| CPU profile while idle | almost all SwiftUI layout: `UnaryLayoutEngine.sizeThatFits`, `GridLayout.Cache`, `NSAttributedString.MetricsCache` | no layout work between events |
| Warm launch to usable | services ready, then the rest of a fixed 2.8 s animation | as soon as services answer |
| Opening the 3,504 event chat with the view mounted | over 4 minutes at about 96% CPU (see "The trap we hit") | 4 s, 2.9 s of CPU in total |
| `GET /api/providers`, polled every 2.5 s | parsed a 593 KB `models-cache.json` each time, 1.2 s in one logged request | parsed once per file change |
| App memory | 393 MB | 417 MB (unchanged; memory is batch 3 work) |

### 1. The idle poll republished everything, every 2.5 seconds

- **Problem.** `AppModel` is one `ObservableObject` with 59 `@Published` fields, and every view
  observes all of it. `pollOnce` assigned `store`, `proposals`, `busyProposals`, `durableEvents`
  and `composer` and ran a full `rebuildTranscript()` on every tick whether or not anything had
  changed; `pollApprovals` did the same to `approvals` every 1.5 s. Each assignment invalidated
  the whole window, and the transcript is an eager `VStack`, so each one re-laid out the entire
  chat history, tables included. That is the 29% idle CPU.
- **Fix.** Compare before assigning, in `pollOnce`, `pollApprovals`, `refreshComposer`,
  `pruneBusyProposals` and `loadRoutines`. The transcript is rebuilt from the poll only when the
  durable events, the store (group attribution reads names from it) or the calendar day (the
  dividers say Today and Yesterday) changed. A proposal card also closes by the clock with no
  change on the wire, so the set of open ids is compared as well as the list.
- **Caught by.** All five models. Astra's round 2 trace listed the seven unconditional writes;
  Astra, Spark and GLM each named the day-label and roster traps; the proposal TTL trap was found
  while implementing.

### 2. Replaying history painted every old event

- **Problem.** A chat's turns live in the eve session, not in the durable store, so
  `ReplayGate.Durable.startsLive` is true and a replay counted as "live" from its first event.
  Every one of several thousand historical events called `publishTranscript()`, and each publish
  laid out the whole chat. On a cold launch the old 2.8 s splash hid this, because no transcript
  was mounted yet. On a chat switch nothing hid it.
- **Fix.** `performReload` does not publish while `historyRemaining > 0`. The forced publish after
  the loop paints the history once. A server that sends no count keeps the old behaviour.
- **Caught by.** Astra (A-05, the exact mechanism: "historyRemaining gates the working indicator
  but doesn't gate publishTranscript"). Spark, GLM, DeepSeek and HY4 reported the replay from
  zero but not the publish gate.

### 3. One bot's new preview rebuilt every row of the open chat

- **Problem.** `TranscriptRowView` is `Equatable` so unchanged rows skip their body, but it was
  handed whole `ShellBot` values. `sessionId`, `lastPreview` and `lastAt` change whenever any bot
  says anything, so a reply in another chat made every row here unequal and rebuilt its markdown.
- **Fix.** Rows get `ShellBot.transcriptFace`: the same bot with those three fields blanked. No
  row reads them (checked across `ChatView`, `NativeAvatar`, `AvatarStackView`, `FacePalette`,
  `ChatAttribution`). Names and avatars still compare, so a rename still redraws.
- **Caught by.** Astra only (round 2, B-01). Spark's round 3 listed the fields each row reads.

### 4. The launch animation was a minimum launch time

- **Problem.** `RootView.showingLaunch` held the splash until a 2.8 s sleep finished, even with
  services already healthy.
- **Fix.** The splash shows only while `phase == .starting`.
- **Caught by.** Astra only (A-13).

### 5. Group attribution was quadratic

- **Problem.** `Transcript.attributeGroupReplies` searched backwards for the last user row and
  re-ran the mention regexes for every assistant bubble, on every publish.
- **Fix.** One forward pass; mentions are resolved once per user turn. Pinned by
  `attributionFollowsTheNewestUserTurnAcrossARunOfReplies`.
- **Caught by.** DeepSeek (A-13); Astra confirmed it in round 2 and noted it is only quadratic
  for long runs of replies under one message.

### 6. Every streamed delta scanned the whole message history

- **Problem.** `StreamProjection.apply` used `firstIndex(where:)` and `contains(where:)` over
  `messages` once or twice per delta, on the main actor, for every streaming bot.
- **Fix.** An id to index dictionary maintained on append and on the optimistic-row id swap.
  First holder wins, as `firstIndex` did.
- **Caught by.** Astra (A-08), DeepSeek, HY4.

### 7. The Send button formatted the whole message to learn whether it was empty

- **Problem.** `canSend` called `Attachments.formatMessage`, which scans every attached file's
  text for fences, three times per body pass, and the body runs on every model publish.
- **Fix.** Sendable means a non-blank draft or at least one attachment, which is exactly when
  the formatted message is non-empty.
- **Caught by.** Astra (B-03), HY4 (A-14).

### 8. A 593 KB JSON file was parsed on every poll and twice per model call

- **Problem.** `readModelsCache` did `readFileSync` plus `JSON.parse` with no memo. The composer
  poll hits it every 2.5 s through `/api/providers`, and the router reads it per completion.
- **Fix.** The parse is kept while the file's inode, size and mtime are unchanged. Writers replace
  the file by rename, so another process's write is always a new inode. `writeModelsCache` drops
  the memo first, because callers edit the object they read. Pinned by a test that swaps in a
  same-size file within the same clock tick.
- **Caught by.** HY4 (measured the 593 KB), GLM (the router reads). Spark and GLM both warned
  that mtime plus size alone is not a safe key.

### 9. Smaller ones

- Display polls (shell, thread, composer) drop to every fourth tick while no window is visible.
  Handoff ticks and approvals keep full cadence. Gated on window occlusion, not on the app being
  active, so a visible window on a second display is never slowed. (Trap from GLM and Spark.)
- `ScrollPinnedTracker` assigns `viewport` only when it changed. Hygiene: GLM and Astra both
  judged the gain near zero, and nothing here claims otherwise.

### The trap we hit

Fix 4 on its own made things far worse. With the splash gone, the transcript was mounted during
the launch replay, and problem 2 became visible: 96% CPU for over four minutes to open one chat,
where the old build took 3 s behind its splash. A before and after measurement caught it; the
tests did not. Lesson: measure each fix on the long chat, not on a fresh one.

### Looked at and not done

- Reusing one `JSONDecoder` per stream line: the allocation is small next to the decode.
- Skipping the `JSONValue` tree for header-only events: marginal, and a closed skip list would
  drop payloads of event types added later (GLM T-08).
- A shared 30 Hz animation clock published app-wide: it would invalidate everything 30 times a
  second (Astra).

## Still open, in the order Astra's plan ranks them

| Item | Why it matters | Risk | Found by |
|---|---|---|---|
| A send still asks eve for the tail index before it posts | about 1.25 s before the reply starts in a YT Producer sized chat | medium | batch 10 measurements |
| A return to a long chat of big markdown answers freezes the main thread | 4.9 s median, 5.5 s worst in the Perf Long Replies fixture (8.6 s on a busy machine); the old chat stays frozen on screen for most of it | high | perf guard baseline, 2026-09-26 |
| A first open with no snapshot runs past the 10 s landing cap on long chats | every first open after a rebuild: 11.3 s (tools) and 12.3 s (markdown) medians, most launches capped | medium | perf guard baseline, 2026-09-26 |
| Each turn on a long chat takes longer than the last | about 35 s × turn number for answers of the same size (33 s at turn 1, 433 s at turn 11) | medium | perf guard fixture build, 2026-09-26 |

Closed: the avatar timelines and 1024 px layers (batch 4), the windowed transcript (batch 5), the
streaming markdown cache (batch 6), the eager widget web views (batch 7), the cache budget (batch 8), the per-tick sweep (batch 9), the cached chat switch resuming from its cursor (batch 10); the store parse memo was measured and
declined.
