# Distributing the macOS app

Useful Bot ships outside the Mac App Store (its shell and file tools can't run in Apple's sandbox) and
without an Apple Developer ID. The app is ad-hoc signed. Updates are signed with our own EdDSA key and
checked by Sparkle, which needs no Apple account.

## What a release is

`npm run release:mac -- --version X.Y.Z` builds, in `macos/dist/release/`:

- `Useful-Bot-macOS.zip`: the app. It carries its services in `Contents/Resources/runtime` (router,
  web build, eve and the agent, production `node_modules`, an official Node 24 checked against a
  pinned SHA-256). Sources come from git's index only, and the build refuses to ship anything named
  like a secret (`.env`, `*.pem`, `secrets/`). See `scripts/build-runtime.mjs`.
- `Useful-Bot-macOS.dmg`: the same app for browser downloads, in the classic install window: the app
  on the left, a link to `/Applications` on the right, over a quiet brand background with "Drag
  Useful Bot to Applications". Built headlessly by [dmgbuild](https://dmgbuild.readthedocs.io)
  (it writes the window's `.DS_Store` itself, no Finder scripting), compressed (UDZO), volume name
  "Useful Bot". The layout is `macos/dmg/settings.py`; the background is drawn at 1x and 2x by
  `macos/dmg/background.swift` (Inter SemiBold from `brand/source/fonts`). Each build mounts the DMG
  read-only out of Finder's sight and checks it (`macos/dmg/verify.py`): the entries, the app's version
  and build, the window layout and bounds, the hidden bars, both background sizes and the volume name
  the background alias records. It then checks the app's signature (`codesign --verify --strict --deep`)
  and that its CDHash matches the zipped app, and detaches it. The DMG file itself is not signed or
  notarized; only the app inside carries its ad-hoc signature.
- `install.sh`: this release's installer, with the zip's URL and SHA-256 written in.
- `appcast.xml`: the one-item Sparkle feed pointing at that zip, with its EdDSA signature.

The zip stays the update and Terminal-install format; the DMG is only the browser download. The
script prints both files' sizes and SHA-256 as JSON. It writes the zip and the DMG first and
`install.sh` and `appcast.xml` last, and deletes the folder if any step fails, so a folder with an
appcast is a whole release. It only clears an `--out` folder that holds nothing but those four
files; anything else there and it refuses. Ctrl-C, SIGTERM or SIGHUP during packaging still
unmounts and cleans up; a signal after the last step leaves the finished release and exits 0.

Prerequisites for the DMG:

- Python 3.10 or later as `python3` (dmgbuild needs it; the Command Line Tools' python3 is 3.9, so
  use Homebrew's). The script checks this before the long build.
- Network on the first run: the script makes a venv at `macos/.build/dmg-venv` and pip-installs
  `dmgbuild`, `ds_store` and `mac_alias`, all three at pinned versions. Later runs reuse it.
- No volume named "Useful Bot" mounted: dmgbuild's working image would take the name "Useful Bot 1"
  and the window background would point at it. The script refuses to start while one is mounted.

The build number (`CFBundleVersion`) is the commit count, so it only grows. The release tree must be
clean; `--allow-dirty` is for test builds only.

## How it runs on a user's Mac

On launch a release copies its runtime to `~/Library/Application Support/Useful Bot/app` when the
version changed (`RuntimeInstall.swift`), first stopping the previous version's services (they
outlive the app, so after an update they would otherwise keep serving from replaced files), mints any missing or expired local credentials
(`setup-local.mjs`), and starts the services from there with its own Node. Eve keeps its sessions in
`app/.eve/`, which a copy never touches. Everything else stays in `~/.useful-bot` as before. Nothing
leaves the Mac.

With no `~/.useful-bot/config.json` but Useful Bot items still in the Keychain (the data folder was
deleted, the app kept), plain setup exits 3 and the app reruns it with `--rebuild-orphaned`, which
replaces every credential and refuses if a config exists; the app then restarts its services so none
keeps the old tokens.

`npm run release:mac` runs `scripts/smoke-runtime.mjs` on the staged runtime right after the build and
before signing. It copies the stage under a temp folder named `Application Support/app` (a path with a
space), seeds a config with the staged `setup-local.mjs` against a file-backed Keychain stub, starts the
staged router with the staged Node and fails the release unless `/health/live` answers within 15 s.
Eve and the web service are not covered: their ports are fixed and they read the real Keychain.

A dev build (`npm run build:app`) has no runtime and no feed: it runs the checkout and never updates
itself. A stored `repoPath` default also keeps a release on that checkout.

## Publishing

Releases live in the public repo `wasimjalali/useful-bot-releases` (release files only, no source).
Each GitHub release `vX.Y.Z` carries `Useful-Bot-macOS.zip`, `Useful-Bot-macOS.dmg`, `appcast.xml`
and `install.sh` (`scripts/install.sh`):

```sh
gh release create vX.Y.Z --repo wasimjalali/useful-bot-releases \
  macos/dist/release/Useful-Bot-macOS.zip macos/dist/release/Useful-Bot-macOS.dmg \
  macos/dist/release/appcast.xml macos/dist/release/install.sh
```

The landing page and README download
`https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/Useful-Bot-macOS.dmg`,
so a release without the DMG breaks the download button. The app's feed is
`https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/appcast.xml`, so the
newest release is always the one offered.

Install for users:

```sh
curl -fsSL https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/install.sh | sh
```

A curl download carries no quarantine flag, so macOS opens the app without the Gatekeeper stop. A
browser download of the DMG (or the zip) works too; the first open then needs System Settings >
Privacy & Security > Open Anyway, once.

## Moving itself to Applications

A release opened from anywhere but `/Applications` or `~/Applications` asks once, before any service
starts, "Move Useful Bot to Applications?" (`MoveToApplications.swift`, decisions in
`AppPlacement.swift`). On Move it copies itself to `/Applications/Useful Bot.app` (or
`~/Applications` when the user cannot write `/Applications`) with ditto, off the main thread, under
a small progress panel with Cancel. The copy goes into a fresh hidden `.Useful Bot.app.moving/`
beside the destination first, with the copying process's pid in `owner.pid`. A later launch removes
one whose owner is gone (or one over an hour old), never a live move's. The quarantine flag is
cleared in the same background pass. It then puts any copy already there in the Trash (put back if
the final rename fails, or the user is told it's in the Trash), reopens from there and quits. A
user who cannot write `/Applications` while an admin's copy is there is sent to that copy instead of
getting a second one. If a Useful Bot is already running from the destination, it comes forward and
this copy quits. Paths are compared by file identity, not spelling, so the app already in
`/Applications` under another name (`/System/Volumes/Data/Applications`, a symlinked folder) is never
offered a move, and no step can trash the only copy. When identity can't be read, nothing is
trashed. A copy left in
Downloads or elsewhere goes to the Trash; a DMG it ran from is ejected once it has quit. When macOS
runs the app from a translocated read-only copy, it finds the original through Security.framework;
if it cannot, it asks the user to drag the app into Applications instead. "Not now" asks again next
launch; "Don't ask again" (`ub.moveToApplicationsSuppressed` in UserDefaults) stops it. Dev builds
never ask.

## Source

The source is public in `wasimjalali/usefulbot` under the GNU AGPL-3.0 (`LICENSE`),
with commercial licenses sold on the side (`CONTRIBUTING.md` holds the contributor agreement that
keeps that possible). That repo gets one snapshot commit per release, not this repo's history: the history
carries the owner's personal address and screenshots of real chats. After a release merges to `main`:

```sh
gh repo clone wasimjalali/usefulbot /tmp/ub-source   # once
node scripts/publish-source.mjs --clone /tmp/ub-source --version X.Y.Z   # read the commit, then:
node scripts/publish-source.mjs --clone /tmp/ub-source --version X.Y.Z --push
```

`--push` opens a PR on the public repo; merge it there. The script leaves out the paths in its
`EXCLUDE` list (third-party captures, OpenAI's model catalog dump, every eval image). A new file that
shows real chats or the owner's account belongs on that list before it is committed.

## Feedback

Every build (dev and release) carries `UBFeedbackURL` in its Info.plist, written by
`macos/build-app.sh` (override with `UB_FEEDBACK_URL`). Settings > Feedback posts there: the Worker
and D1 in `services/feedback/` (see its README). Only what the owner types, plus the version line if
they leave it ticked, leaves the Mac.

## The signing key

The private EdDSA key is in the release Mac's login Keychain (account `useful-bot`) with a backup in the
owner's password manager. The public key is in `scripts/release-mac.mjs`. Without the private key no
installed copy can ever accept another update, so never delete it without a backup.

## Limits

- Apple silicon, macOS 14 or later.
- The app still sees a new user's first provider only after they connect one in the app: the router
  starts "limited" without the OpenCode Go key.
- Eve's self-modification writes into `app/agent/`; the next update replaces those files.
