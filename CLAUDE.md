# Useful Bot: working rules

Project rules for coding agents. The global rules in `~/.claude/` still apply; this file
governs what they leave open, and wins where the two disagree.

## Surfaces and priority

This product is the macOS app. Everything else serves it.

1. **macOS app** (`macos/`). The primary surface, and the one that gets the design effort,
   the verification screenshots and the first fix. A feature is not done until it works here.
2. **Mobile app.** Planned, not built yet. Design decisions that would be expensive to undo
   on a phone are worth thinking about now; nothing else about mobile is in scope until it
   starts.
3. **No web UI.** The browser UI was removed on 2026-09-28 (PR 1 of the launch plan); git
   history keeps it. `web/` is now only the API service the apps call (`web/app/api`, the
   eve proxy in `web/app/eve`), and `/` returns a plain status. Do not add browser pages.
   The one exception (decided 2026-09-29): the public website, the landing and privacy pages on
   `bot.usefulbuild.com`, lives in this repo under `site/` (static files on a Cloudflare assets
   Worker; deploy with `npx wrangler deploy --config site/wrangler.jsonc`).
4. **CLI.** Not a concern. Do not build new CLI surfaces or spend design effort on one.
   Existing CLI and script entry points stay as they are: there is no need to remove them.

When a change touches more than one surface, do the macOS work first and completely.

## Change management

Adversarial review in Claude Code runs one Opus 5.5 reviewer (up to two for a large diff) plus
one Sonnet 5.5 reviewer, in parallel, each on the areas it suits. Sonnet runs at medium for most
reviews and high for tough ones (the orchestrator picks); never xhigh or max. SWE-2 was retired
here on 2026-09-28; other harnesses (Codex, Devin) may still use it, with the briefing rules in
the global rules. Not Muse Spark or GLM in opencode, not `/code-review`. Check out the branch
under review first: the reviewer reads the files, and a diff against code that is not in the
tree wastes the pass. Never accept a bare empty array, ask for the list
of what it dismissed and why. Fix every finding above low (critical, high, medium, major) and
review again until a pass from every reviewer has none. Then fix every low too; lows need no
further pass. Then merge, rebuild the app and install it from local `main`.

This arrangement expires on 2026-10-15; ask Wasim what to move to rather than falling back.

## Verification

A UI change is verified with a real screenshot of the running macOS app, not with tests
alone. Any live check that sends a message goes to the bot named "Test Bot": pick it in
the rail, or create it first if it is missing. Never send a test turn to any other bot;
those hold real conversations. `/Applications/Useful Bot.app` is the installed copy people
use; rebuilding means `npm run build:app` then `npm run install:app` (not a bare `ditto`).

**Logo and icon gotcha.** Launch Services keeps a record for every bundle with the id
`ai.useful.bot` it has ever seen: `macos/dist`, agent scratch copies, old "before" builds. At
launch the Dock can take its icon from any of them, so a stale copy flashes an old logo (the
very old terminal one, 2026-09-28) until the app sets its own. `install:app` unregisters every
other copy and re-registers the installed one with a fresh date. When the logo changes: update
`brand/app/macos/UsefulBot.icns`, give the bundle's icon file a new name (`CFBundleIconFile` in
`macos/bundle/Info.plist` and the copy in `macos/build-app.sh`; macOS caches the Dock tile by that
name, so the old logo stayed on a pinned tile until the app ran), rebuild, run `install:app`, clear the
system icon cache once on this Mac (`sudo rm -rf /Library/Caches/com.apple.iconservices.store &&
killall Dock`, the owner runs it: it needs his password), and check that
`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -B8 "identifier: *ai.useful.bot"` lists only `/Applications`. Never
leave extra copies of the app lying around, including in scratch folders.

`build:app` also builds the web service. The installed app serves that build only while the
sources under `web/`, `shared/`, `agent/`, `router/src` and `brand/source` still hash to what it
was built from; after an edit there the launcher falls back to `next dev` until the next
`build:app` (see `scripts/web-mode.mjs`). The web service has to be restarted to pick either
one up. Build the web service through `build:app`, not bare `next build`: Next's TypeScript
auto-install rewrites `package-lock.json`, and the router refuses a changed lockfile.

## Performance guard

Until launch, PRs don't run `npm run perf:check` (decided 2026-09-28, to stop spending 20 minutes
on every PR). The check runs once before the macOS app ships to users (after the landing page and
the rest of launch are done): on `main` and on the newest open branch, each on its own `build:app`
(about 20 minutes; it quits and relaunches the app in the background), and the records it writes
under `evals/results/` are committed. After launch, every change that touches `macos/`, `shared/`,
`agent/`, `router/src` or `web/` runs it again before merge. A breach is fixed, or the
budget in `perf/budgets.json` is raised in a reviewed edit that says why; a re-run never erases a
breach. The fixture bots ("Perf ...") are frozen: never send to them. See `perf/README.md`.
