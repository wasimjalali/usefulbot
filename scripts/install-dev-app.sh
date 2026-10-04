#!/bin/sh
# Installs this checkout's dev build (macos/dist/Useful Bot Dev.app) into
# ~/Applications. It only ever touches the dev app: it quits a running
# ai.useful.bot.dev by bundle id, replaces ~/Applications/Useful Bot Dev.app,
# and unregisters other Launch Services copies of ai.useful.bot.dev. It never
# looks at /Applications/Useful Bot.app or any ai.useful.bot entry. It refuses a
# build that did not finish or is older than the working tree.
set -eu

DEV_ID="ai.useful.bot.dev"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/macos/dist/Useful Bot Dev.app"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/Useful Bot Dev.app"

[ -d "$SRC" ] || { echo "No build at $SRC. Run npm run build:dev-app first." >&2; exit 1; }

# Fail loud unless the bundle is the dev app, so a daily build can never land
# in the dev slot (and the dev app can never be mistaken for the daily one).
SRC_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SRC/Contents/Info.plist" 2>/dev/null || true)"
SRC_VARIANT="$(/usr/libexec/PlistBuddy -c 'Print :UBVariant' "$SRC/Contents/Info.plist" 2>/dev/null || true)"
if [ "$SRC_ID" != "$DEV_ID" ] || [ "$SRC_VARIANT" != "dev" ]; then
  echo "$SRC is not the dev app (id '$SRC_ID', UBVariant '$SRC_VARIANT'); expected $DEV_ID and dev. Not installing." >&2
  exit 1
fi

# build-app.sh deletes the build record when a dev build starts and writes it just
# before signing, so a missing one means the last build failed, and a different one
# means the tree changed since.
NODE=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -n "$NODE" ] || { echo "node not found in /usr/local/bin or /opt/homebrew/bin" >&2; exit 1; }
RECORD="$SRC/Contents/Resources/ub-dev-build.txt"
if [ ! -f "$RECORD" ]; then
  echo "The last dev build did not finish ($RECORD is missing). Run npm run build:dev-app and check it succeeded. Not installing." >&2
  exit 1
fi
NOW="$("$NODE" "$ROOT/scripts/dev-build-fingerprint.mjs")"
if [ "$(cat "$RECORD")" != "$NOW" ]; then
  echo "The dev build is older than the working tree. Run npm run build:dev-app and check it succeeded. Not installing." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# By bundle id, never by name or path pattern: the daily app's executable name
# is a prefix of the dev one's.
WAS_RUNNING=0
if osascript -e "application id \"$DEV_ID\" is running" 2>/dev/null | grep -q true; then
  WAS_RUNNING=1
  echo "Quitting the running Useful Bot Dev..."
  osascript -e "tell application id \"$DEV_ID\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    osascript -e "application id \"$DEV_ID\" is running" 2>/dev/null | grep -q true || break
    sleep 0.5
  done
  if osascript -e "application id \"$DEV_ID\" is running" 2>/dev/null | grep -q true; then
    echo "Useful Bot Dev is still running. Quit it and run this again." >&2
    exit 1
  fi
fi

NEW="$DEST.installing"
trap 'rm -rf "$NEW"' EXIT
rm -rf "$NEW"
ditto "$SRC" "$NEW"
codesign --verify --strict "$NEW"
trap 'echo "Install stopped. The new build is at $NEW: move it to $DEST by hand." >&2' EXIT
rm -rf "$DEST"
mv "$NEW" "$DEST"
trap - EXIT
touch "$DEST"

# Only identifier == ai.useful.bot.dev (an exact match: the daily id is a
# prefix of it) and never the install path.
"$LSREGISTER" -dump | awk '
  /^path:/ { sub(/^path:[ ]+/, ""); sub(/ \(0x[0-9a-f]+\)$/, ""); path = $0 }
  /^identifier:[ ]+ai\.useful\.bot\.dev$/ { print path }
' | sort -u | while IFS= read -r stale; do
  [ "$stale" = "$DEST" ] && continue
  echo "Unregistering $stale"
  "$LSREGISTER" -u "$stale" || true
done
"$LSREGISTER" -f "$DEST"

echo "Installed $DEST"
if [ "$WAS_RUNNING" = 1 ]; then open "$DEST"; fi
