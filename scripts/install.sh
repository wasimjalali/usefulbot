#!/bin/sh
# Installs Useful Bot on a Mac:
#   curl -fsSL https://github.com/wasimjalali/useful-bot-releases/releases/latest/download/install.sh | sh
#
# The app has no Apple Developer ID, so this clears its quarantine flag to skip
# the "unidentified developer" stop. What it trusts instead: the release this
# copy was published with. scripts/release-mac.mjs writes that release's zip
# URL and SHA-256 below, and a download that does not match is refused.
# Updates then arrive in the app, checked against its EdDSA key.
set -eu

URL="@@ZIP_URL@@"
SHA256="@@ZIP_SHA256@@"
DEST="${UB_INSTALL_DIR:-/Applications}"
APP="$DEST/Useful Bot.app"

say() { printf '%s\n' "$*"; }
die() { printf 'Useful Bot install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Useful Bot runs on macOS only."
[ "$(uname -m)" = "arm64" ] || die "Useful Bot needs a Mac with Apple silicon (M1 or later)."
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 14 ] || die "Useful Bot needs macOS 14 or later (this Mac has $(sw_vers -productVersion))."
[ -w "$DEST" ] || die "$DEST is not writable. Run with UB_INSTALL_DIR=\"\$HOME/Applications\" to install for this user only."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading Useful Bot…"
case "$URL$SHA256" in *@@*) die "this is the unreleased template; install from a release's install.sh." ;; esac
# HTTPS only; plain HTTP just for a local test server.
case "$URL" in http://127.0.0.1:*) proto='=http' ;; *) proto='=https' ;; esac
curl -fL --proto "$proto" --progress-bar -o "$tmp/Useful-Bot-macOS.zip" "$URL" || die "the download did not complete."
got="$(shasum -a 256 "$tmp/Useful-Bot-macOS.zip" | cut -d' ' -f1)"
[ "$got" = "$SHA256" ] || die "the download does not match this release (sha256 $got, expected $SHA256)."
ditto -x -k "$tmp/Useful-Bot-macOS.zip" "$tmp/unpacked" || die "the download is not a valid zip."
[ -d "$tmp/unpacked/Useful Bot.app" ] || die "the download does not contain Useful Bot.app."
codesign --verify --strict "$tmp/unpacked/Useful Bot.app" || die "the app's code signature does not verify."

if pgrep -x UsefulBotApp >/dev/null 2>&1; then
  say "Quitting the running Useful Bot…"
  osascript -e 'tell application id "ai.useful.bot" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

# Staged beside the old copy and checked there, so a copy cut short (a full
# disk) leaves the installed app as it was.
NEW="$DEST/.Useful Bot.app.installing"
rm -rf "$NEW"
ditto "$tmp/unpacked/Useful Bot.app" "$NEW" || { rm -rf "$NEW"; die "could not copy the app into $DEST."; }
xattr -cr "$NEW"
codesign --verify --strict "$NEW" || { rm -rf "$NEW"; die "the copied app does not verify."; }
rm -rf "$APP"
mv "$NEW" "$APP"

say "Installed $APP"
open "$APP"
