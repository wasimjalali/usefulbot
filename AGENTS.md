# Useful Bot: working rules (AGENTS.md; CLAUDE.md imports it)

Project rules for coding agents. Wasim's global rules still apply (see Change management); this
file governs what they leave open, and wins where the two disagree.

## Surfaces and priority

This product is the macOS app. Everything else serves it.

1. **macOS app** (`macos/`). The primary surface, and the one that gets the design effort,
   the verification screenshots and the first fix. A feature is not done until it works here.
2. **Mobile app.** Planned, not built yet. Design decisions that would be expensive to undo
   on a phone are worth thinking about now; nothing else about mobile is in scope until it
   starts.
3. **No web UI.** The browser UI was removed on 2026-09-28 (PR 1 of the launch plan); git
   history keeps it. `web/` is now only the API service the apps call (`web/app/api`, which
   proxies the chat routes to the engine), and `/` returns a plain status. Do not add browser pages.
   The one exception (decided 2026-09-29): the public website, the landing and privacy pages on
   `bot.usefulbuild.com`, lives in this repo under `site/` (static files on a Cloudflare assets
   Worker; deploy with `npx wrangler deploy --config site/wrangler.jsonc`).
4. **CLI.** Not a concern. Do not build new CLI surfaces or spend design effort on one.
   Existing CLI and script entry points stay as they are: there is no need to remove them.

When a change touches more than one surface, do the macOS work first and completely.

## Change management

The global rules set the loop, parallel work, reviews, models and cloud handoffs:
`~/.agents/AGENTS.md` locally, and the same file written by the "Wasim" cloud environment's setup
script in cloud sessions. What this repo adds:

- **Shared resources take turns, run by the orchestrator only:** Useful Bot Dev (one app identity,
  state in `~/.useful-bot-dev-app`, ports 4419/4420/4421, `com.usefulbot.dev.*` Keychain items),
  `npm run build:dev-app` and `install:dev-app` (a build swaps the installed dev app), the dev
  app's bot, its engine and `perf:check`. Worktree workers run `tsc`, lint, node tests and Swift builds and tests in their
  own tree, never the dev app.
- **After every merge:** sync local `main`, then rebuild and reinstall Useful Bot Dev from it
  (`npm run build:dev-app`, `npm run install:dev-app`). The daily app is not rebuilt per PR: it
  updates through releases (see Verification).
- **Cloud sessions** can't run the macOS app: a PR that changes `macos/` gets the `needs-local`
  label and a Local handoff section, and waits for a live check in Useful Bot Dev before merge.
- Write briefs and commit messages with the Write tool: the bash guard blocks heredocs with odd
  quotes.

## Verification

A UI change is verified with a real screenshot of the running macOS app, not with tests
alone. Drive it with the `mac-computer-use` skill and save artifacts under `verify/<branch>/`.
**Every live check runs in Useful Bot Dev, never the daily app** (decided 2026-10-01,
UB-004). `/Applications/Useful Bot.app` is the owner's daily install with his real chats: agents
never launch, quit, screenshot-test or send to it. Useful Bot Dev is a separate identity
(`ai.useful.bot.dev`, `~/Applications/Useful Bot Dev.app`, state in `~/.useful-bot-dev-app`,
`com.usefulbot.dev.*` Keychain items, ports 4419/4420/4421). Build and install it with
`npm run build:dev-app` then `npm run install:dev-app`. The dev app carries a runtime built from
the working tree (stage `macos/.build/runtime-stage-dev`, stamp `<version>-dev+<sha>.<hash>`) and
runs its services from a copy under `~/Library/Application Support/Useful Bot Dev/app`, never from
the checkout (an ad hoc signed bundle gets a fresh Desktop-folder privacy prompt on every rebuild,
and a service reading the checkout blocks on it). Inside the dev app, a check that sends
a message goes to its one bot (`bot-useful`), never into a perf fixture chat. Never use `~/.useful-bot-dev`: it
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

`npm run perf:check` runs once per release, before the release build, not on each PR (decided
2026-10-08; it takes about 20 minutes). It runs on its own `build:dev-app`, drives only Useful Bot
Dev and never quits or relaunches the daily app, and the records it writes under `evals/results/`
are committed. It's a shared resource: one run at a time, by the orchestrator. A breach is fixed, or the
budget in `perf/budgets.json` is raised in a reviewed edit that says why; a re-run never erases a
breach. The fixture chats ("Perf ...", synthetic Pi session files from `scripts/perf-fixtures.mjs`,
hidden from the sidebar) are frozen: never send to them. They are written with the dev app quit
(`perf/run.sh fixtures`, which also locks them) and measured by `rows_first_paint` and `rows_done`
as well as the landing. See `perf/README.md`.

## Pi SDK updates

A weekly cloud routine ("Useful Bot: weekly Pi SDK update", Mondays 09:00 Berlin, set up
2026-10-25) checks for a newer `@earendil-works/pi-coding-agent`. When there is one, it bumps the
exact pin, restamps the registry, runs the tests and opens a `pi-update` + `needs-local` PR (pick
it up like any `needs-local` PR). Pi ships about three releases a week, so don't bump it by hand
in feature PRs: keep all Pi calls behind `agent/engine/` so a bump stays an adapter change.

## Code traps

- **A worktree resolves missing packages from the main checkout.** Worktrees sit under
  `.claude/worktrees/`, so Node and TypeScript walk up to the main checkout's `node_modules` and
  find a package this branch removed. A leftover import of a removed package type-checks and runs
  there and fails only in the shipped app. Grep for the import instead of trusting a passing run
  (found 2026-10-25, PR 3).

- **Never call `Process.waitUntilExit()` after an `await`, or from a thread other than the one that
  ran the process.** Foundation can then wait forever on that thread's stale task state (it hung
  `ProcessRunnerRealTests` about 1 run in 100; root cause in PR #216). Use `terminationHandler`
  (with a semaphore if you must block) or poll `isRunning`.
