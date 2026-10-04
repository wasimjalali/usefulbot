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

Since 2026-10-01, Opus 5.5 plans, orchestrates and verifies. Sonnet 5.5 writes the code:
`sonnet-worker` (medium) for scoped jobs, `sonnet-sweeper` (high) for audits. Opus checks every
worker's result before it lands.

Reviews run in parallel, split by area so every file in the diff has an owner:
- **Small, non-sensitive PRs:** Sonnet 5.5 alone.
- **Bigger or sensitive PRs:** Sonnet 5.5 plus GPT-6.1-Sol at medium through Codex
  (`codex exec -m gpt-6.1-sol -c model_reasoning_effort="medium" --sandbox read-only
  --output-last-message <file> - < <brief>`).
- **Tough or very sensitive work:** add one Opus 5.5 reviewer at medium.
- **Muse Spark in opencode:** may join as an extra free reviewer when it's available, never as
  the only one.

Not `/code-review`. Write briefs and commit messages with the Write tool: the bash guard blocks
heredocs with odd quotes. Check out the branch under review first: the reviewer reads the files,
and a diff against code that is not in the tree wastes the pass. Never accept a bare empty array,
ask for the DISMISSED list of what it considered and why. Fix every finding above low (critical, high, medium, major) and
review again until a pass from every reviewer has none. Then fix every low too; lows need no
further pass. Then merge, sync local `main`, and rebuild and reinstall Useful Bot Dev from it
(`npm run build:dev-app`, `npm run install:dev-app`). The daily app is not rebuilt per PR: it
updates through releases (see Verification).

This arrangement expires on 2026-10-15; ask Wasim what to move to rather than falling back.

## Verification

A UI change is verified with a real screenshot of the running macOS app, not with tests
alone. **Every live check runs in Useful Bot Dev, never the daily app** (decided 2026-10-01,
UB-004). `/Applications/Useful Bot.app` is the owner's daily install with his real bots: agents
never launch, quit, screenshot-test or send to it. Useful Bot Dev is a separate identity
(`ai.useful.bot.dev`, `~/Applications/Useful Bot Dev.app`, state in `~/.useful-bot-dev-app`,
`com.usefulbot.dev.*` Keychain items, ports 4419/4420/4421). Build and install it with
`npm run build:dev-app` then `npm run install:dev-app`. The dev app carries a runtime built from
the working tree (stage `macos/.build/runtime-stage-dev`, stamp `<version>-dev+<sha>.<hash>`) and
runs its services from a copy under `~/Library/Application Support/Useful Bot Dev/app`, never from
the checkout (an ad hoc signed bundle gets a fresh Desktop-folder privacy prompt on every rebuild,
and a service reading the checkout blocks on it). Inside the dev app, a check that sends
a message still goes to "Test Bot" (create it if missing). Never use `~/.useful-bot-dev`: it
holds older owner data. The daily app is a release build with a runtime payload: it comes from
`npm run release:mac` (installed from the DMG or by Sparkle), and only when the owner asks for it.
A plain `npm run build:app` then `npm run install:app` installs a checkout-run daily app instead
(no runtime payload, services read this checkout); while one is installed, `build:dev-app` refuses
by design, because the dev build would swap that app's web build underneath it. Use that path only
when the owner asks for it, and reinstall a release before the next dev build.

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
the rest of launch are done): on `main` and on the newest open branch, each on its own
`build:dev-app` (about 20 minutes; it drives only Useful Bot Dev and never quits or relaunches
the daily app), and the records it writes
under `evals/results/` are committed. After launch, every change that touches `macos/`, `shared/`,
`agent/`, `router/src` or `web/` runs it again before merge. A breach is fixed, or the
budget in `perf/budgets.json` is raised in a reviewed edit that says why; a re-run never erases a
breach. The fixture bots ("Perf ...") are frozen: never send to them. See `perf/README.md`.
