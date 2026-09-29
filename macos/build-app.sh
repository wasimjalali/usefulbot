#!/bin/sh
# Build the native app using the sole approved brand/ asset package.
set -eu
cd "$(dirname "$0")"

# The web service the app talks to. scripts/service.mjs serves this build while
# the sources still hash to what it was built from and falls back to `next dev`
# otherwise, so a release always leaves a fresh one behind. The standalone
# server does not carry its own static files; Next leaves that copy to us. The
# service has no browser UI, so there is no public folder to copy.
#
# Next does not recognise TypeScript 7 as `typescript` and runs `npm install`
# for it on every build. Nothing gets installed, but npm rewrote the lockfile,
# and the router refuses to start on a lockfile whose hash changed. The two
# npm_config settings keep that install from writing either manifest.
NODE=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -n "$NODE" ] || { echo "node not found in /usr/local/bin or /opt/homebrew/bin" >&2; exit 1; }
(
  set -eu
  cd ..
  # `next dev` leaves route types under .next/dev/types that web/tsconfig.json
  # includes. A build never refreshes them, so types for deleted routes would
  # fail the release's tsc_web step; drop them and let the next `next dev` redo them.
  rm -rf web/.next/dev/types
  npm_config_package_lock=false npm_config_save=false "$NODE" node_modules/next/dist/bin/next build web
  rm -rf web/.next/standalone/web/.next/static web/.next/standalone/web/public
  cp -R web/.next/static web/.next/standalone/web/.next/static
  # The build repoints this generated, tracked file from the dev types to the
  # build types. Put back so a release build leaves the tree clean.
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git checkout -- web/next-env.d.ts
  fi
  "$NODE" scripts/web-mode.mjs --stamp
  # A release carries the services it runs (scripts/build-runtime.mjs).
  if [ -n "${UB_RELEASE:-}" ]; then
    "$NODE" scripts/build-runtime.mjs macos/.build/runtime-stage "${UB_VERSION:?UB_RELEASE needs UB_VERSION}+${UB_BUILD:?UB_RELEASE needs UB_BUILD}"
  fi
)

swift build -c release
APP="dist/Useful Bot.app"
BIN=".build/release/UsefulBotApp"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/UsefulBotApp"
chmod +x "$APP/Contents/MacOS/UsefulBotApp"
cp bundle/Info.plist "$APP/Contents/Info.plist"
# Sparkle ships signed by its authors; ditto keeps that signature. The updater
# only runs when a release build writes its feed and key (UB_FEED_URL and
# UB_ED_PUBLIC_KEY, set by scripts/release-mac.mjs); dev builds carry neither.
rm -rf "$APP/Contents/Frameworks"
mkdir -p "$APP/Contents/Frameworks"
ditto .build/release/Sparkle.framework "$APP/Contents/Frameworks/Sparkle.framework"
if [ -n "${UB_FEED_URL:-}" ]; then
  [ -n "${UB_ED_PUBLIC_KEY:-}" ] || { echo "UB_FEED_URL is set without UB_ED_PUBLIC_KEY" >&2; exit 1; }
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $UB_FEED_URL" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $UB_ED_PUBLIC_KEY" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool true" "$APP/Contents/Info.plist"
  # Every 6 hours rather than Sparkle's daily default, so the account menu's
  # Update now shows up the same day a release lands.
  /usr/libexec/PlistBuddy -c "Add :SUScheduledCheckInterval integer 21600" "$APP/Contents/Info.plist"
fi
# Where Settings > Feedback posts (services/feedback). Every build carries it;
# UB_FEEDBACK_URL points a build at another Worker.
/usr/libexec/PlistBuddy -c "Add :UBFeedbackURL string ${UB_FEEDBACK_URL:-https://feedback.usefulbuild.com/v1/feedback}" "$APP/Contents/Info.plist"
# Chat snapshots are trusted across builds while the replay logic they were
# folded under is unchanged (AppModel.snapshotKey). That logic is the fold in
# UsefulBotCore plus AppModel, which feeds it (the resume follower, the replay
# swap, the prewarm builder), so a change in either replays each chat once.
[ -d Sources/UsefulBotCore ] && [ -f Sources/UsefulBotApp/AppModel.swift ] || { echo "snapshot key sources moved: update build-app.sh" >&2; exit 1; }
SNAPSHOT_LOGIC=$( (find Sources/UsefulBotCore -type f -name '*.swift' -print0; printf '%s\0' Sources/UsefulBotApp/AppModel.swift) \
  | LC_ALL=C sort -z | xargs -0 shasum -a 256 \
  | shasum -a 256 | cut -c1-16)
/usr/libexec/PlistBuddy -c "Add :UBSnapshotLogic string $SNAPSHOT_LOGIC" "$APP/Contents/Info.plist"
if [ -n "${UB_VERSION:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $UB_VERSION" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${UB_BUILD:?UB_VERSION needs UB_BUILD}" "$APP/Contents/Info.plist"
fi
# Named after the logo it holds, and renamed whenever the logo changes, so
# nothing that cached the bundle's icon by file name can match the old one.
# (A Dock tile pinned before the change can still hold the old picture until
# the system icon cache is cleared: see the logo gotcha in CLAUDE.md.) The
# last build's icon file goes first, so the bundle carries only this one.
find "$APP/Contents/Resources" -maxdepth 1 -name '*.icns' -delete
cp ../brand/app/macos/UsefulBot.icns "$APP/Contents/Resources/UsefulBotHead.icns"

for asset in png/mark/useful-bot-128.png png/black/useful-bot-256.png svg/useful-bot-wordmark.svg source/avatar-palette.json source/avatar-face.svg source/motion.json app/macos/UsefulBot.icns; do
  mkdir -p "$APP/Contents/Resources/Brand/$(dirname "$asset")"
  cp "../brand/$asset" "$APP/Contents/Resources/Brand/$asset"
done
# Builds write into the same bundle; the avatar PNGs are no longer shipped.
rm -rf "$APP/Contents/Resources/Brand/avatars"
mkdir -p "$APP/Contents/Resources/Brand/motion" "$APP/Contents/Resources/Brand/providers"
cp -R ../brand/motion/native "$APP/Contents/Resources/Brand/motion/"
cp ../brand/providers/*.svg "$APP/Contents/Resources/Brand/providers/"
rm -rf "$APP/Contents/Resources/runtime"
if [ -n "${UB_RELEASE:-}" ]; then
  ditto .build/runtime-stage "$APP/Contents/Resources/runtime"
fi
# What the binary was built from, so the performance guard can refuse to time
# an app that is older than the sources under review (perf/runner/perfguard.py).
find Sources Package.swift -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 \
  | shasum -a 256 | cut -d' ' -f1 > "$APP/Contents/Resources/ub-app-sources.sha256"
# The only nested code is Sparkle.framework, already signed, so signing the
# bundle directly is enough and avoids the discouraged --deep flag.
codesign --force --sign - "$APP" >/dev/null
codesign --verify --strict "$APP"
echo "built $APP"
