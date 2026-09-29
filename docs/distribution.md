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
- `install.sh`: this release's installer, with the zip's URL and SHA-256 written in.
- `appcast.xml`: the one-item Sparkle feed pointing at that zip, with its EdDSA signature.

The build number (`CFBundleVersion`) is the commit count, so it only grows. The release tree must be
clean; `--allow-dirty` is for test builds only.

## How it runs on a user's Mac

On launch a release copies its runtime to `~/Library/Application Support/Useful Bot/app` when the
version changed (`RuntimeInstall.swift`), first stopping the previous version's services (they
outlive the app, so after an update they would otherwise keep serving from replaced files), mints any missing or expired local credentials
(`setup-local.mjs`), and starts the services from there with its own Node. Eve keeps its sessions in
`app/.eve/`, which a copy never touches. Everything else stays in `~/.useful-bot` as before. Nothing
leaves the Mac.

A dev build (`npm run build:app`) has no runtime and no feed: it runs the checkout and never updates
itself. A stored `repoPath` default also keeps a release on that checkout.

## Publishing

Releases live in the public repo `wasimjalali/useful-bot-releases` (release files only, no source).
Each GitHub release `vX.Y.Z` carries `Useful-Bot-macOS.zip`, `appcast.xml` and `install.sh`
(`scripts/install.sh`). The app's feed is
`https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/appcast.xml`, so the
newest release is always the one offered.

Install for users:

```sh
curl -fsSL https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/install.sh | sh
```

A curl download carries no quarantine flag, so macOS opens the app without the Gatekeeper stop. A
browser download of the zip works too; the first open then needs System Settings > Privacy & Security >
Open Anyway, once.

## Source

The source is public in `wasimjalali/usefulbot` under PolyForm Noncommercial 1.0.0 or
PolyForm Small Business 1.0.0, at the user's choice (`LICENSE.md`). That repo gets one snapshot commit per release, not this repo's history: the history
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
