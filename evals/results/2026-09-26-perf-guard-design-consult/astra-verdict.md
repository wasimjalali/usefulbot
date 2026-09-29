**Verdict: approve the structure, but change the measurement contract before making it a merge gate.** The proposed endpoint can pass before rendering finishes, and uncontrolled cache state can make identical runs exercise different paths. This review is based on code and documentation. I changed nothing and didn’t run the app.

**A. `select → landed` is useful, but it isn’t the user-visible duration.**

In [landRestored](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/ChatView.swift:468), the 16 ms sleeps sample geometry while the transcript is hidden. Setting `landedBotId` requests visibility. The subsequent 34 ms sleep merely delays `finishFirstPaint`; neither sleep proves that frames were presented. Rendering and display happen after the app submits its updates. [Apple’s render-loop explanation](https://developer.apple.com/videos/play/tech-talks/10855/)

Concrete changes:

- Start immediately inside `select`, **before `stashCurrentThread()`**, so outgoing-chat work counts. Record notification dispatch→handler separately; handler timing excludes input-queue delay.
- Keep `landingReady` as a diagnostic milestone. Measure the visual endpoint from timestamped capture: the correct newest turn is visible, positioned correctly and remains stable through reload confirmation and deferred window expansion.
- Record **before dispatch through settling**, not only after “landed”. Otherwise you miss the blank, mascot and jump being guarded.
- Check responsiveness after landing too. Deferred row construction can freeze an otherwise unchanged picture.
- Log why landing ended. Both landing loops can reach the ten-second cap and still assign `landedBotId`; timeout, missing geometry or failed reload must not count as successful settling.
- Instrument initial selection separately: [startup assigns `selectedBotId` directly](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:529), bypassing `select`. Define an endpoint for an intentionally empty chat too.

For cold launch, start the runner’s clock before launching the process. An in-app “launched” event misses earlier launch work.

At 30 fps, visual timing has roughly 33 ms granularity. That cannot resolve a 12 ms regression against a 60 ms baseline. Prefer display-rate capture and keep numerical precision honest.

**B. The notification hook is acceptable for this local harness, with restrictions.**

Apple explicitly says distributed notifications have unbounded delivery latency, may be dropped and aren’t secure communication. Don’t treat posting time as selection time. [DistributedNotificationCenter](https://developer.apple.com/documentation/foundation/distributednotificationcenter)

Require the explicit process argument, fixture mode, a run identifier, request identifier and allow-listed bot ID. Acknowledge acceptance and completion; timeout on missing responses. Reject duplicate requests and same-bot no-ops. A run nonce prevents accidental cross-talk, but isn’t sender authentication.

The launch argument disables the listener during normal launches; it doesn’t guarantee that an installed copy can never enable it. Keep the operation limited to selection, with no arbitrary commands, paths or chat contents.

URL schemes and AppleScript add little here. XCUITest would reintroduce the accessibility measurement problem. For fixed scenarios, an argument-gated in-app sequencer is an even simpler alternative.

**C. Choose a sanitized, frozen clone, isolated from the owner’s data.**

Use option **(c)**, provided you can produce a consistent clone of the session plus associated bot metadata, durable rows and referenced assets. Don’t assume copying one eve directory is sufficient. Pin the runtime version and fixture hash. If cloning isn’t supported, build deterministic recorded events through the supported storage path.

Real conversations are useful for diagnosis, but poor merge gates. Event growth isn’t a reliable rebaseline trigger. Live model turns also introduce cost and nondeterministic fixture content.

The [performance record](/Users/wasimjalali/Desktop/useful-bot/docs/audit/PERFORMANCE.md:278) says Drive Admin’s 3,504 events produced only 36 rows. Include both:

- A replay-heavy history with many tool events.
- A rendering-heavy history exceeding 60 blocks, including large Markdown/code replies and a large newest turn.

Record event count, bytes, rendered blocks, largest turn and assets. Freeze the fixture rather than increasing budgets as it grows.

Opening real bots isn’t completely read-only: `select` persists selection, and switching can write snapshots.

**D. Five runs are a smoke test, not reliable intermittent-regression detection.**

If slowness independently occurs on 10% of switches, five runs catch it only 41% of the time. Thirty catch it about 96%.

I’d use five launches per cold case, ten normal warm switches and thirty long-chat returns. Keep median plus an absolute worst-run ceiling. Don’t estimate a tail percentile from five samples.

Warm up warm cases with one prescribed sequence. Never discard the first measured visit from a “first visit” case. Preflight power mode, thermal state, memory pressure, display configuration and competing workloads. Record them.

Discard only documented harness failures or external interruptions, preserving their artifacts. App-generated load, prewarming and slow runs aren’t discard reasons. A rerun must not erase a breach.

**E. Cache state needs to be part of each case’s definition.**

[Snapshot compatibility](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:315) depends on executable size/mtime. Snapshots also expire. [Prewarming](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:3314) starts after a three-second delay. These can explain variable paths, though they don’t establish the reported bug’s cause.

Separate:

- Fresh process with valid, unchanged snapshots.
- Fresh process without valid snapshots.
- Snapshot resume with a fixed appended event sequence.
- Warm memory-cache return.
- Return after cache eviction and after expanding earlier history.

Generate valid snapshots using the candidate binary; don’t reuse another build’s snapshots. Record the actual restore source, cursor and prewarm activity. Distinguish app-cold from service-cold. Verify release binaries and production Next.js mode; this repo can fall back to development mode after source edits.

**The runner and budget policy need four final changes.**

1. Don’t rely solely on retrospective `log show`. Info/debug messages aren’t normally persisted. Capture signposts live, or emit a small structured result containing app-computed monotonic durations. Correlate PID, launch ID, request ID and selection generation. Missing, duplicate or mismatched events must fail. [Apple logging documentation](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code)
2. Store baseline measurements separately from enforceable limits. Apply the 20% allowance once. Set the worst-run ceiling deliberately, rather than copying the largest observed sample.
3. An audit should **propose** budget changes with evidence, never automatically overwrite them. Rebaseline historical numbers using this harness; the audit already documents incompatible timing methods.
4. Keep the separate skill, committed runner and `evals/results/` artifacts. Include source/build hashes, fixture hash, exact command, capture timestamps and all failures. Framesheets supplement full recordings. Local execution is reasonable, but attach results to the exact reviewed commit. Until CPU/RSS cases exist, those gains remain unguarded.