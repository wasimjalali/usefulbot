#!/bin/sh
# Build the native app using the sole approved brand/ asset package.
set -eu
cd "$(dirname "$0")"

# UB_VARIANT=dev builds "Useful Bot Dev": its own bundle id, name, executable and
# output folder, so it runs beside the daily app and shares nothing with it
# (UsefulBotCore/AppVariant.swift holds every other value). It never carries
# the updater or the production feedback URL. It carries a runtime payload like
# a release does, staged apart from the release one (macos/.build/runtime-stage-dev,
# from the working tree, stamped <package version>-dev+<git sha>.<content hash>),
# because the app runs its services from a copy under its own Application
# Support folder, never from the checkout (a build signed ad hoc gets a new
# macOS privacy grant for the Desktop folder on every rebuild). The daily build
# is what runs when UB_VARIANT is unset.
VARIANT="${UB_VARIANT:-daily}"
case "$VARIANT" in
  daily) ;;
  dev)
    if [ -n "${UB_RELEASE:-}${UB_FEED_URL:-}${UB_ED_PUBLIC_KEY:-}${UB_FEEDBACK_URL:-}${UB_VERSION:-}${UB_BUILD:-}" ]; then
      echo "UB_VARIANT=dev cannot be combined with the release settings (UB_RELEASE, UB_FEED_URL, UB_ED_PUBLIC_KEY, UB_FEEDBACK_URL, UB_VERSION, UB_BUILD)" >&2
      exit 1
    fi
    ;;
  *) echo "UB_VARIANT must be unset or dev, not \"$VARIANT\"" >&2; exit 1 ;;
esac

# The dev build rebuilds the checkout's web/.next and restamps its web-mode
# (below). A daily app with no runtime payload (a plain `npm run build:app` +
# `install:app`, not a release) runs its services from this checkout and serves
# that same build, so a dev build would swap its web build underneath it. Refuse
# rather than touch it. A release install carries a payload and is unaffected.
# UB_TEST_DAILY_APP names the installed copy to check; it exists for tests only
# and the path being checked is always printed.
if [ "$VARIANT" = dev ]; then
  DAILY_APP="${UB_TEST_DAILY_APP:-/Applications/Useful Bot.app}"
  echo "Checking the daily app for a runtime payload: $DAILY_APP"
  if [ -d "$DAILY_APP" ] && [ ! -d "$DAILY_APP/Contents/Resources/runtime" ]; then
    echo "Refusing to build the dev app: $DAILY_APP has no Contents/Resources/runtime." >&2
    echo "Why: a daily app without a runtime payload (what a plain npm run build:app + install:app produces) runs its services from this checkout," >&2
    echo "and the dev build rebuilds web/.next and restamps web-mode here, which would swap that app's web build underneath it." >&2
    echo "Fix: install a release build of the daily app, which carries a runtime payload (for example the latest GitHub release), then run npm run build:dev-app again." >&2
    exit 1
  fi
fi

# UB_GUARD_ONLY exists for macos/test-build-guard.sh only: exit 0 right after the
# guard above, before anything is built or locked.
if [ -n "${UB_GUARD_ONLY:-}" ]; then exit 0; fi

# One build at a time: two runs (daily and dev, or two of either) would race on
# web/.next and macos/.build. The lock is a file holding the owner's pid. It is
# written to a temp file first and hard-linked into place, so it appears whole
# or not at all and `ln` fails if it exists. A lock whose pid is gone is moved
# aside under the takeover mutex (re-checked there) and taken again; a pid-less lock younger
# than 10 s is treated as held, and ownership is re-read after taking it.
LOCK=".build/build-app.lock"

lock_holder() {
  if [ -d "$LOCK" ]; then cat "$LOCK/pid" 2>/dev/null || true; else cat "$LOCK" 2>/dev/null || true; fi
}

lock_age() {
  _mtime="$(stat -f %m "$LOCK" 2>/dev/null || true)"
  if [ -n "$_mtime" ]; then echo $(( $(date +%s) - _mtime )); else echo 0; fi
}

take_build_lock() {
  mkdir -p .build
  _mine=".build/build-app.lock.$$"
  echo "$$" > "$_mine"
  _tries=0
  while :; do
    if [ ! -e "$LOCK" ] && ln "$_mine" "$LOCK" 2>/dev/null; then break; fi
    _tries=$((_tries + 1))
    HOLDER="$(lock_holder)"
    if [ -n "$HOLDER" ]; then
      if kill -0 "$HOLDER" 2>/dev/null; then
        rm -f "$_mine"
        echo "Another build-app.sh run (pid $HOLDER) holds macos/$LOCK. Wait for it to finish; two builds race on web/.next and macos/.build." >&2
        return 1
      fi
    elif [ -e "$LOCK" ] && [ "$(lock_age)" -lt 10 ]; then
      rm -f "$_mine"
      echo "macos/$LOCK is held by a run that has not written its pid yet. Wait a few seconds and try again." >&2
      return 1
    fi
    if [ "$_tries" -ge 20 ]; then
      rm -f "$_mine"
      echo "Could not take macos/$LOCK" >&2
      return 1
    fi
    # Stale. A bare mv of the lock could move a fresh lock a faster racer just
    # took, so clearing goes through a mutex (mkdir is atomic): one racer at a
    # time re-reads the holder and removes the lock only if it is still the
    # stale one judged above. Nobody else removes the lock, and a new one
    # cannot appear while the stale one is in place (ln fails on an existing
    # name), so what is removed is exactly what was checked.
    if mkdir "$LOCK.takeover" 2>/dev/null; then
      echo "$$" > "$LOCK.takeover/pid"
      _now="$(lock_holder)"
      if [ -e "$LOCK" ] && [ "$_now" = "$HOLDER" ] && { [ -z "$_now" ] || ! kill -0 "$_now" 2>/dev/null; }; then
        if mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null; then rm -rf "$LOCK.stale.$$"; fi
      fi
      rm -rf "$LOCK.takeover"
    else
      # Another racer is clearing it; a mutex left by a dead run is cleared.
      _taker="$(cat "$LOCK.takeover/pid" 2>/dev/null || true)"
      if [ -n "$_taker" ] && ! kill -0 "$_taker" 2>/dev/null; then rm -rf "$LOCK.takeover"; fi
      sleep 0.1
    fi
  done
  rm -f "$_mine"
  if [ "$(lock_holder)" != "$$" ]; then
    echo "Lost macos/$LOCK to another build-app.sh run; try again." >&2
    return 1
  fi
}

release_build_lock() {
  if [ -f "$LOCK" ] && [ "$(cat "$LOCK" 2>/dev/null || true)" = "$$" ]; then rm -f "$LOCK"; fi
  rm -f ".build/build-app.lock.$$"
}

take_build_lock || exit 1
trap 'release_build_lock' EXIT
trap 'exit 1' INT TERM HUP

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

# A dev build records what it was made from, as its last step before signing
# (scripts/install-dev-app.sh checks it). Taken now, so an edit made while the build
# runs leaves the record stale. Dropping the old record first means a build that fails
# from here on leaves a bundle with none.
if [ "$VARIANT" = dev ]; then
  DEV_FINGERPRINT="$("$NODE" ../scripts/dev-build-fingerprint.mjs)"
  rm -f "dist/Useful Bot Dev.app/Contents/Resources/ub-dev-build.txt"
fi
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
  # A release carries the services it runs (scripts/build-runtime.mjs), and so
  # does the dev app, from its own stage so a release stage is never mixed in.
  if [ "$VARIANT" = dev ]; then
    PKG_VERSION="$("$NODE" -p "require('./package.json').version")"
    "$NODE" scripts/build-runtime.mjs macos/.build/runtime-stage-dev "$PKG_VERSION-dev+$(git rev-parse --short HEAD)" --dev
  elif [ -n "${UB_RELEASE:-}" ]; then
    "$NODE" scripts/build-runtime.mjs macos/.build/runtime-stage "${UB_VERSION:?UB_RELEASE needs UB_VERSION}+${UB_BUILD:?UB_RELEASE needs UB_BUILD}"
  fi
)

swift build -c release
if [ "$VARIANT" = dev ]; then
  APP="dist/Useful Bot Dev.app"
  EXE="UsefulBotDevApp"
else
  APP="dist/Useful Bot.app"
  EXE="UsefulBotApp"
fi
BIN=".build/release/UsefulBotApp"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXE"
chmod +x "$APP/Contents/MacOS/$EXE"
cp bundle/Info.plist "$APP/Contents/Info.plist"
if [ "$VARIANT" = dev ]; then
  # Keep these in step with AppVariant.dev; the app refuses to start when the
  # id, executable and UBVariant disagree.
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.useful.bot.dev" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Useful Bot Dev" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Useful Bot Dev" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $EXE" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :UBVariant string dev" "$APP/Contents/Info.plist"
fi
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
# The dev build carries none: its Send is off.
if [ "$VARIANT" = dev ]; then
  /usr/libexec/PlistBuddy -c "Add :UBFeedbackURL string" "$APP/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :UBFeedbackURL string ${UB_FEEDBACK_URL:-https://feedback.usefulbuild.com/v1/feedback}" "$APP/Contents/Info.plist"
fi
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
if [ "$VARIANT" = dev ]; then
  ditto .build/runtime-stage-dev "$APP/Contents/Resources/runtime"
elif [ -n "${UB_RELEASE:-}" ]; then
  ditto .build/runtime-stage "$APP/Contents/Resources/runtime"
fi
# What the binary was built from, so the performance guard can refuse to time
# an app that is older than the sources under review (perf/runner/perfguard.py).
find Sources Package.swift -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 \
  | shasum -a 256 | cut -d' ' -f1 > "$APP/Contents/Resources/ub-app-sources.sha256"
# The only nested code is Sparkle.framework, already signed, so signing the
# bundle directly is enough and avoids the discouraged --deep flag.
if [ "$VARIANT" = dev ]; then printf '%s\n' "$DEV_FINGERPRINT" > "$APP/Contents/Resources/ub-dev-build.txt"; fi
codesign --force --sign - "$APP" >/dev/null
codesign --verify --strict "$APP"
echo "built $APP"
