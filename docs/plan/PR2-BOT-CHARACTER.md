# PR 2: Bot character (master prompt and plan)

Settled with Wasim on 2026-09-28. Design canvas: https://claude.ai/artifact/UPBYJc74rF8Ysy1jbuxaPM
(boards "Circle head", "A · Look and think", "Sidebar"). Branch `feat/bot-character`.

## Master prompt

Give every bot the new face and motion, and the rail the new layout, in the macOS app only.

- **Face (locked):** a true circle in the bot's tint, a 1 pt hairline edge, the original glasses
  and eyes, and the wide open smile with the pink tongue. No highlight on the head. Same face at
  every size (16 to 72 pt), in every place a bot head shows.
- **Working motion (direction A, "Look and think"):** the eyes say what the bot is doing.
  Thinking: glance up, small bob, blink (2.6 s). Writing: eyes scan left to right (1.3 s).
  Tool: look down and tap (0.9 s). Compacting uses Thinking. The working row's label stops
  pulsing. Idle heads never move.
- **Rail:** the same eye motion on a working bot's row, and the row's subtitle shows the
  activity ("THINKING", "WRITING", the tool step). When a reply lands in a bot you are not
  looking at, its head hops once and the subtitle reads "REPLY READY" until you open it
  (in memory only, not persisted).
- **Sidebar layout:** one pinned bot is a wide card with a 48 pt head. Two or more are tiles,
  two per row, head on top and name under. The selected pin gets a thin ink outline.
- **Unassigned (decided):** the header shows only when it holds a visible bot, like Hidden
  already does. A pinned bot lives in the pinned area only, so pinning the last unassigned bot
  removes the header, and creating an unsectioned bot brings it back. Named sections keep their
  empty hint, because you made them and need them as a place to move bots.
- **Reduce motion:** no movement at all. A working head holds a still pose (eyes up for
  Thinking, down for a tool) and the hop is skipped.
- **Out of scope:** the full-body mascot (launch screen, chat loading state, app icon),
  other UI polish (PR 3), the web service, CLI.

## Plan

1. **brand:check green.** Strip `width`/`height`/`style` from the root `<svg>` of each
   `brand/providers/*.svg` and keep their `<title>`; fix whatever the check reports next. No
   change to the check's rules. Commit on its own.
2. **Face source.** Add `brand/source/avatar-face.svg` (circle, glasses, eyes, mouth, one
   viewBox). `scripts/build-brand-assets.mjs` builds `brand/avatars/<tint>.svg` and `-256.png`
   from it instead of the dome head; `npm run brand:build`, then `brand:check`.
3. **Native face.** `BotFaceGeometry` (UsefulBotCore): the face's paths and anchors, parsed
   once from the SVG. `BotFaceLayerView` (UsefulBotApp, NSViewRepresentable): a layer tree
   (head, glasses, mouth, two eyes in an eye group) drawn as vector at any size.
   `BotFaceView`, `BotAvatarView` and `AvatarStackView` use it, so static and moving heads are
   the same drawing.
4. **Motion.** `BotFaceMotion` (UsefulBotCore): the keyframes for think, write, tool and hop,
   as data. The view installs them as Core Animation keyframe
   animations, so they run at the display's rate on the render server with no per-frame
   SwiftUI work. Reduce motion removes them and sets the still pose. Replace the
   `BrandMotionView(avatar: true)` use in `RailView` and `BrandMotionFrameView` in `WorkingRow`;
   drop the label pulse. Remove `avatar-head.png` and the `avatar` branch if nothing else
   uses them (grep first).
5. **Rail.** Pinned card and tiles in `RailView`/`PinnedCardView`, activity subtitle, reply-ready
   hop and flag (`AppModel`, cleared on select), Unassigned hidden when empty.
6. **Verify, review, land** (below). Update `docs/plan/LAUNCH-PLAN.md` (PR 2 done) and
   `brand/README.md` where the head is described.

Sonnet 5.5 workers took steps 1, 2 and 5 (scoped); I built 3 and 4 and checked what they returned.

## Done means

- `npm run brand:check` passes; `swift build`, the Swift tests and the Node tests pass.
- Heads are circles at every size: screenshots of the rail, pinned card and tiles, chat row,
  header pill, group stack and details pane.
- 60 fps frame-by-frame review with `winrec` at 60 fps and `framesheet`: three runs of a Test
  Bot turn (one from a cold start of the app), covering Thinking, Writing and a tool step in
  both the rail and the chat row, plus the reply-ready hop. No dropped or doubled frames, no
  jumps between states. Then the same with Reduce motion on: nothing moves.
- Idle CPU with one bot working stays near today's, measured with `top` over 30 s before
  and after (baseline taken on `main` before the build).
- Live sends go only to Test Bot. No `perf:check`.
- Review: SWE-2 (`swe-2-high`; motion and rail logic) plus one Opus 5.5 reviewer (layer view,
  reduce motion, CPU). Fix everything above low, re-review, then fix lows.
- Merge, `npm run build:app`, `ditto` into `/Applications`, restart the web service.
