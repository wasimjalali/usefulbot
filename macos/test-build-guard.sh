#!/bin/sh
# The dev build's guard in build-app.sh: refuse when the installed daily app has no
# runtime payload, allow when it has one (or is not installed), and always print
# which app it checked. UB_GUARD_ONLY=1 (test-only) makes the script exit 0 right
# after the guard, so nothing is built. UB_TEST_DAILY_APP points the guard at a
# temp folder, never the real /Applications copy.
set -eu
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

run_guard() { UB_VARIANT=dev UB_GUARD_ONLY=1 UB_TEST_DAILY_APP="$1" sh ./build-app.sh 2>&1; }

# Refuse: an installed daily app with no runtime.
mkdir -p "$TMP/NoRuntime.app/Contents/Resources"
if out="$(run_guard "$TMP/NoRuntime.app")"; then fail "no runtime: expected a refusal, got success"; fi
echo "$out" | grep -q "Refusing to build the dev app" || fail "no runtime: refusal message missing: $out"
echo "$out" | grep -qF "Checking the daily app for a runtime payload: $TMP/NoRuntime.app" || fail "no runtime: checked path not printed: $out"

# Allow: a runtime payload is present.
mkdir -p "$TMP/Release.app/Contents/Resources/runtime"
out="$(run_guard "$TMP/Release.app")" || fail "runtime present: expected success: $out"
echo "$out" | grep -qF "Checking the daily app for a runtime payload: $TMP/Release.app" || fail "runtime present: checked path not printed: $out"
echo "$out" | grep -q "Refusing" && fail "runtime present: must not refuse: $out"

# Allow: no daily app installed at all.
out="$(run_guard "$TMP/Missing.app")" || fail "not installed: expected success: $out"
echo "$out" | grep -qF "$TMP/Missing.app" || fail "not installed: checked path not printed: $out"

# The guard only applies to the dev variant: a daily build never reaches it.
if UB_GUARD_ONLY=1 UB_VARIANT=bogus sh ./build-app.sh >/dev/null 2>&1; then fail "a bad variant must still be rejected"; fi

echo "build guard: ok"
