# Launch plan (macOS)

Written 2026-09-28, after PR #145 (first run, settings, feedback Worker). What's left before the
macOS app ships to users, split into one PR per session.

## How each session runs

1. Open the session with this file and the PR's section below.
2. Settle that PR's master prompt and master plan together with Wasim. The section below is a
   starting point, not a spec.
3. Build, verify live in the running app (screenshots, and 60 fps frame-by-frame review for
   anything that moves), review (one Opus 5.5 plus one Sonnet 5.5 reviewer, split by area), fix,
   merge, install (`npm run install:app`).
4. No `perf:check` per PR. It runs once, in PR 6.

The mobile app (its own worktree) waits until after launch.

## PR 1: Web app decision

**Decided 2026-09-28: removed.** The browser UI is gone, `/` returns a plain status, and Tailwind
went with it. The notes below are the question as it was asked.

- **What exists:** `web/` is two things. One is the Next.js API (`web/app/api`, 15 route groups,
  plus the eve proxy in `web/app/eve`). The Mac app talks to it, so it stays either way. The
  other is the browser UI (`web/app/page.tsx` and its components, about 5,500 lines of TSX plus
  1,280 of CSS).
- **Keep it:** making it pixel-identical to macOS means redoing every Mac screen in React, then
  keeping the two in step on every future change. That's several PRs now, plus a tax on every
  PR after.
- **Remove it (recommended):** delete the browser UI and keep the API service. The Mac app is the
  product, the phone app will use the same API, and nothing in launch needs a browser UI. Git
  history keeps it if it ever comes back.
- **Done when:** the decision is made. If it's removal: the UI is gone, `/` returns a plain
  status, `build:app` and the Mac app still work, and the rules in `CLAUDE.md` ("Surfaces and
  priority") are updated.

## PR 2: Bot character

**Built 2026-09-28** on `feat/bot-character`: circle face with a smile, motion A ("Look and
think"), the pinned card and tiles, Unassigned hidden when empty, and `brand:check` green. The
settled prompt and plan are in `docs/plan/PR2-BOT-CHARACTER.md`; measurements in
`evals/results/2026-09-28-pr2-bot-face.md`. The notes below are the brief as it was written.

The bots are the brand. Make them feel cute and premium.

- **Head shape:** a true circle.
- **Working animation:** redo the animation shown while a bot is working.
- **Rail:** motion for the bot in the sidebar.
- **Session shape:** Opus 5.5 first studies the current avatars (`NativeAvatar.swift`,
  `OperatorAvatar.swift`, `FacePalette.swift`, `BrandMotion.swift`) and proposes the shape and the
  motions as a design (a canvas is fine). Wasim picks, then it gets built.
- **Left from PR 1: `npm run brand:check` is red on `main`.** The provider logos added in #145
  (`brand/providers/*.svg`) fail its SVG lint: fixed `width`/`height` on the root `<svg>` and no
  `<title>`, starting with `alibaba.svg` and `command-code.svg`. Fix the logos (or teach the
  check their rules on purpose) so the check is green before new avatar assets land.
- **Done when:**
  - `npm run brand:check` passes.
  - Heads are circles at every size.
  - The animations pass 60 fps frame-by-frame review with reduced motion respected.
  - Idle CPU with a working bot stays near today's.

## PR 3: UX polish pass

- **What:** Opus 5.5 audits every user-facing surface of the Mac app and proposes subtle
  improvements (visuals, spacing, motion, copy, empty and error states) where it can do better
  than today. The surfaces are the rail, chat, composer, cards, settings, first run, popovers and
  the Library.
- **How:** the audit is a ranked list with a screenshot and a one-line why for each item. Wasim
  picks, then the picks are built.
- **Carried over from #145:**
  - Disabled buttons use 55% opacity instead of the mockup's sunken look.
  - The appearance switch is instant.
  - The entrance into a large existing chat drops frames.
- **Bug to fix in this PR (reported 2026-09-28): attached images show as a path, not a picture.**
  - **Seen:** attach an image in the composer and send it with a message. The sent user message
    shows the image's file name or path as text. It doesn't show the picture.
  - **Wanted:**
    - The composer shows a small preview of each attached image before sending.
    - The sent user message shows the image a bit larger, above the message text.
    - The picture stays after a relaunch or a chat replay.
    - No file path is ever shown to the user.
  - **Where to start:** `macos/Sources/UsefulBotCore/Attachments.swift`. `formatMessage` adds
    "Attached image: <name>" and `echoedMessage` adds `[file: <name> (<type>)]` lines to the
    stored text, and the pixels aren't kept after the send ("the pictures themselves are long
    gone"). The sent row therefore has only those lines to show. Also check `attachmentsRow` in
    `ComposerView.swift`, the user bubble in `ChatView.swift`, and how eve replays the turn
    (`transcript-lives-in-eve-not-durable-store` in memory). A local copy per sent image, for
    example beside the media store, is likely what lets the bubble draw it after a relaunch.
  - **Done when:** screenshots show the composer preview and the sent bubble for one and for
    several images, before and after a relaunch. The model still gets the pixels, and the
    `[file: …]` lines never show.
- **To decide and fix in this PR (reported 2026-09-28): how a bot hears back from its sub-agents.**
  - **Seen:** when a bot's background sub-agent finishes, its result lands in the chat as an
    owner message. It sits in the right-hand bubble and reads "Background task task_… (agent) is
    completed. Result: …". Visual Creator showed this on 2026-09-28.
  - **Wanted:** sub-agent traffic stays between the main agent and its sub-agents, out of the
    owner's side of the chat. The owner sees it only in the bot's working state: the working
    animation or step row says a sub-agent is running, and then that its result came back. The
    main agent then answers in its own bubble.
  - **Decide first, with Wasim:** how the result reaches the main agent (an internal eve event,
    a tool result or a hidden turn, rather than a user message), and what the UI shows. Options
    include a line in the working row, a small collapsible "sub-agent" step or nothing beyond
    the animation. Check how eve delivers background task completions and where the Mac app
    turns them into transcript rows before picking.
  - **Done when:** a live Test Bot turn that starts a sub-agent shows it only in the working
    state. No owner bubble appears for its result, before or after a relaunch or replay, and the
    main agent still uses the result.
- **Done when:** every picked item is built and verified by screenshot. If the list is long it
  splits in two, so that's one or two PRs.

## PR 4: Landing page on bot.usefulbuild.com

- **Status (2026-09-29):** sub-agent reports carry eve's `kind` mark (`scripts/patch-eve.mjs`)
  and merged reports all settle; snapshots are keyed to the `UsefulBotCore` hash (a rebuild's
  first open 10.7 s to 0.8 s, `evals/results/2026-09-29-snapshot-key.md`); eve and Next telemetry
  are off; the site lives in `site/` and is live, showing "Coming soon" instead of the download
  until PR 5; `ReleaseLinks.privacy` is set. The Dock icon waits on Xcode (owner installing).

- **Carried over from PR 3 (macOS, do these first):**
  - **Done in PR 4:** **Sub-agent messages without eve's wording still show as the owner's.** PR 3 hides a
    sub-agent's result only when it arrives in eve's own form ("Background task task_… is
    completed", "failed", "is cancelled", "needs input", "needs authorization", "update:") and
    names a task the app saw start. eve's `wakeTaskMessageParentStep` can also send a
    background tool's or workflow's message into the parent session as plain text, with no
    prefix and no marker on the stream, so the app can't tell it from the owner. Not confirmed
    whether the `agent` tool itself does this. Start by reproducing it on Test Bot. The likely
    fix is upstream: have eve forward its internal `execution.background_task` kind on
    `message.received` (a small patch or a vendor request), then filter on that instead of text.
  - **Done in PR 4:** **A long chat's first open after a rebuild or update takes 9 to 11 s.** Chat snapshots are
    keyed to the exact app binary (`AppModel.buildId`), so every new build, and so every
    Sparkle update for users, replays each chat from zero on its first open. A same-build
    relaunch lands in about 0.9 s. Measured in `evals/results/2026-09-29-pr3-polish.md`. Look at
    keying snapshots by `ChatSnapshot.formatVersion` (which already guards the stored shape)
    instead of the binary, with whatever projection-logic guard that needs.
  - **The app icon draws grey in the Dock until the app is running (macOS 26).** Checked on
    2026-09-29 after installing the new logo: while launching, the Dock shows the head as a grey
    face on black, then it turns white once the app sets its own icon. The bundle ships only a
    flat `.icns`; macOS 26 renders such icons with its legacy treatment. The fix is a compiled
    asset catalog (`Assets.car` with an `AppIcon`, ideally from an Icon Composer `.icon`), which
    needs Xcode's `actool` (this Mac has only the Command Line Tools). Installing Xcode is the
    owner's call. Also, on this Mac a pinned tile kept the old full-body logo while idle until the
    system icon cache is cleared (the owner runs the command in the CLAUDE.md logo gotcha).

- **Page:**
  - A beautiful landing page for Useful Bot on the new subdomain `bot.usefulbuild.com`.
  - Its primary button is the macOS download:
    `https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/Useful-Bot-macOS.zip`.
  - It also shows the one-line installer.
  - It uses real screenshots of the polished app, so it comes after PRs 2 and 3.
- **Privacy:** reuse the existing usefulbuild.com privacy page if it covers this product. If not,
  add `bot.usefulbuild.com/privacy`. It has to say what the app sends (feedback form only, plus an
  anonymous install ID) and that chats go to the model provider the user connects.
- **Hosting:** Cloudflare, following how the two existing usefulbuild.com subdomains are set up.
  Settle in session whether the site's code lives in this repo (for example `site/`) or its own.
- **App wiring:**
  - Set `ReleaseLinks.privacy` in `AppSettingsView.swift`.
  - Point Contact rows at the page if useful.
- **Done when:** the page is live on the subdomain (desktop and phone widths checked), the privacy
  link opens from Settings > About, and the download link resolves. It resolves after PR 5
  publishes.

## PR 5: Release readiness and live verification

- **Status (2026-09-29):**
  - License: GNU AGPL-3.0 plus paid commercial licenses (owner's call, 2026-09-29, after a
    PolyForm draft). The OSI-approved license keeps the "open source" label that OpenClaw and Hermes
    (both MIT) also have. The copyleft steers companies that build on it toward a commercial
    license. Outside contributions come under the agreement in `CONTRIBUTING.md`.
  - Source: it goes public as snapshots in `wasimjalali/usefulbot` (renamed from useful-bot-source on the owner's call)
    (`scripts/publish-source.mjs`, `docs/distribution.md`), because this repo's history holds the
    owner's personal Gmail and real-chat screenshots. It went public on 2026-09-29 with the
    v1.0.0 snapshot; GitHub detects the license as AGPL-3.0.
  - The #144 lows are fixed. v1.0.0 is built locally (`macos/dist/release`), with nothing
    uploaded.
  - The owner gave the go to publish v1.0.0 on 2026-09-29, after the PR 6 perf check. The stray
    repo is deleted. Still open: installing Xcode (the Dock icon).

- **Clean-Mac check: dropped (owner's call, 2026-09-29).** The Devin macOS VM run and its
  `devin-dist-prompt.md` are no longer part of launch; the prompt was lost from the Trash. Checks
  run on this Mac instead.
- **PR #144 lows:** fix every open low listed in its description.
- **Release repo:** create the public repo `wasimjalali/useful-bot-releases` and publish v1.0.0
  (`npm run release:mac`), only on Wasim's go. Then remove `data-release="soon"` from
  `site/public/index.html`, put the JSON-LD `downloadUrl` back (the same zip URL as the CTA) and redeploy the site, and turn on
  `ReleaseLinks.releasesRepoLive`
  (What's new, Report a bug on GitHub).
- **Live checks left from #145:**
  - "Install update" on a real update.
  - Back during the device-code fetch.
  - A Feedback send from the installed app (Idea, "[test]").
  - Settings > About shows the version after PR 1 (it reads `/api/status`). A background
    cua-driver can't reach the account popover, so this needs a window where the pointer may be
    used, or an in-app route to Settings.
- **Wasim's own switch:** Wasim moves to the installed release as a clean first-time user. Back up
  `~/.useful-bot` and the repo `.eve` first.
- **Source (was "Open source", superseded 2026-09-29):** the source is public as snapshots in
  `wasimjalali/usefulbot` under the AGPL-3.0. **Done 2026-09-29:** the repo is public
  with the v1.0.0 snapshot. Run `scripts/publish-source.mjs` again for each release.
  The landing chat shot's "Useful Bot is also open source." is accurate again under the AGPL.
- **Done when:** a fresh Mac installs from the landing page, runs first run end to end, and takes
  an update.

## PR 6: Pre-launch performance check

- **What:** `npm run perf:check` on `main` and on the newest open branch, each on its own
  `build:app`, on a quiet Mac. Compare against the 2026-09-27 pass
  (`evals/results/2026-09-27-perf-check-2000-c450c11`). Sparkle is linked into every build since
  #144.
- **After a breach:** fix it, or raise the budget in `perf/budgets.json` in a reviewed edit that
  says why.
- **Done when:** both runs pass and their records are committed. Then launch.
- **Done 2026-09-29 (PR #162), run on this Mac:** markdown tables moved from `Grid` to a cached
  `TableLayout` (the long-replies chat opens in about 500 ms instead of 1,311). A no-snapshot landing
  that could stick is fixed, and the harness now samples CPU during each launch. Only `main` was
  checked, since no other branch was open. The clean PASS was at 19:36. The final run at 20:04 had no
  breaches but was INCONCLUSIVE from a 2-second macOS burst, and the owner accepted it. Details:
  `evals/results/2026-09-29-prelaunch-perf-fixes.md`.

## Order

PR 1, 2, 3, 4, 5, 6: six sessions, seven if the polish pass splits.

- **Web first:** done in #148. The browser UI is gone, so PRs 2 to 6 are macOS only.
- **Landing page after the polish:** it needs screenshots of the polished app.
- **Perf last:** it measures what ships.
