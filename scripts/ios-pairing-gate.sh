#!/usr/bin/env bash
# The PR-2 live gate (spec 17.3): drives PairingFlowUITests through a real
# dev-path pairing lifecycle against the running stack — pair, sign out, sign
# in, revoke, rotate, re-pair. The test bundle cannot touch the host
# credential store, so the legs are separate xcodebuild invocations and the
# phone credential flips between them.
#
# Prereqs: the dev stack running (npm run web:dev + router/eve), a phone
# credential enrolled (setup-local.mjs --pair-phone), a booted iOS sim.
# Usage: SIM_ID=<device-udid> scripts/ios-pairing-gate.sh
#   XCB overrides the xcodebuild binary; SIM_NAME/OS select the destination
#   when SIM_ID is unset.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# The pair file below holds a live device token; nothing it or the nohup
# logs create should be world-readable.
umask 077
NODE=/usr/local/bin/node
XCB="${XCB:-xcodebuild}"
SIM_ID="${SIM_ID:-}"
if [ -n "$SIM_ID" ]; then
  DEST="platform=iOS Simulator,id=$SIM_ID"
else
  DEST="platform=iOS Simulator,name=${SIM_NAME:-iPhone 17},OS=${SIM_OS:-latest}"
fi

# Password autofill suppression: a typed SecureField submission fires
# Keychain's "Save Password?" sheet asynchronously, and it has shipped in
# gate shots. The allowPasswordAutoFill restrictedBool payload is the
# headless equivalent of Settings > Passwords > AutoFill off; write it
# while the sim is shut down so the settings daemon reads it cold, then
# boot it back up here — a leg racing the cold boot dies with
# "Mach error -308" before the first test line.
sim_udid() {
  if [ -n "$SIM_ID" ]; then printf '%s' "$SIM_ID"; return; fi
  xcrun simctl list devices available -j | /usr/bin/python3 - "${SIM_NAME:-iPhone 17}" <<'PY'
import json, sys
name = sys.argv[1]
for runtime, devs in json.load(sys.stdin)["devices"].items():
    if "iOS" not in runtime:
        continue
    for d in devs:
        if d["name"] == name:
            print(d["udid"]); sys.exit(0)
sys.exit("no iOS sim named %r" % name)
PY
}

disable_password_autofill() {
  local udid dev
  udid=$(sim_udid)
  dev="$HOME/Library/Developer/CoreSimulator/Devices/$udid"
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    xcrun simctl list devices -j | /usr/bin/python3 -c "
import json,sys
for devs in json.load(sys.stdin)['devices'].values():
    for d in devs:
        if d.get('udid')=='$udid' and d.get('state')=='Shutdown': sys.exit(0)
sys.exit(1)" && break
    sleep 0.5
  done
  for plist in \
    "$dev/data/Containers/Shared/SystemGroup/systemgroup.com.apple.configurationprofiles/Library/ConfigurationProfiles/UserSettings.plist" \
    "$dev/data/Library/UserConfigurationProfiles/EffectiveUserSettings.plist" \
    "$dev/data/Library/UserConfigurationProfiles/PublicInfo/PublicEffectiveUserSettings.plist"; do
    mkdir -p "$(dirname "$plist")"
    /usr/bin/python3 - "$plist" <<'PY'
import plistlib, sys, os
path = sys.argv[1]
if os.path.exists(path):
    with open(path, "rb") as f: d = plistlib.load(f)
else:
    d = {}
d.setdefault("restrictedBool", {}).setdefault("allowPasswordAutoFill", {})["value"] = False
with open(path, "wb") as f: plistlib.dump(d, f)
PY
  done
  # Cold-boot now and let launchd settle: the first leg must find a device
  # that is up, not one still starting.
  xcrun simctl boot "$udid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    xcrun simctl list devices -j | /usr/bin/python3 -c "
import json,sys
for devs in json.load(sys.stdin)['devices'].values():
    for d in devs:
        if d.get('udid')=='$udid' and d.get('state')=='Booted': sys.exit(0)
sys.exit(1)" && break
    sleep 0.5
  done
  sleep 5
}
disable_password_autofill

PAIR_FILE=/tmp/ub-pair.json
REVOKED_FLAG=/tmp/ub-pair-revoked
WEB_DOWN_FLAG=/tmp/ub-web-down
EVE_DOWN_FLAG=/tmp/ub-eve-down
STUB_UP_FLAG=/tmp/ub-stub-up
STUB_PORT=59999
STUB_PID=""
WEB_PID=""
EVE_KILLED=""

payload() {
  # --print-pairing answers {"error":"not_paired"} on a dead credential —
  # that still matches '^{', so require the real shape.
  "$NODE" scripts/setup-local.mjs --print-pairing --host http://127.0.0.1:4320 \
    | grep '^{' | head -1 | grep '"token"'
}

leg() {
  local test_name="$1"
  local class="${2:-PairingFlowUITests}"
  echo "--- leg $class/$test_name"
  "$XCB" \
    -project ios/UsefulBot.xcodeproj -scheme UsefulBot \
    -destination "$DEST" \
    -only-testing:"UsefulBotUITests/$class/$test_name" \
    test
}

# cfprefsd acks persist() before its async plist flush lands, and the next
# leg's reinstall migrates whatever the file holds at that moment (observed:
# `unpaired` carried into the revoke leg, `signedOut` into the runtime-down
# leg). Hold the boundary until the banked state is on disk; the newest
# container plist is the live install's (the UUID moves on every reinstall).
wait_banked() {
  local expected="$1" udid deadline plist state
  udid=$(sim_udid)
  deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    plist=$(ls -t "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Containers/Data/Application/"*/Library/Preferences/com.usefulbot.app.plist 2>/dev/null | head -1 || true)
    if [ -n "$plist" ] \
      && [ "$(/usr/libexec/PlistBuddy -c 'Print :pairing.state' "$plist" 2>/dev/null)" = "$expected" ]; then
      return 0
    fi
    sleep 0.25
  done
  echo "wait_banked: pairing.state never reached '$expected'" >&2
  return 1
}

# XCTest screenshots censor `isSecureTextEntry` content — the masked
# bullets render fine on device but never reach the PNG. Legs that
# evidence a filled Pairing token field drop a `.hold-<name>` sentinel
# once the state is composed and wait for `.done-<name>`; this watcher
# answers with a `simctl io` framebuffer capture, which is what the
# committed evidence ships.
WATCHER_PID=""
start_secure_watcher() {
  local udid
  udid=$(sim_udid)
  (
    while :; do
      for h in /tmp/ub-shots/.hold-*; do
        [ -e "$h" ] || continue
        name="${h##*/.hold-}"
        xcrun simctl io "$udid" screenshot "/tmp/ub-shots/$name.png" >/dev/null 2>&1
        touch "/tmp/ub-shots/.done-$name"
        rm -f "$h"
      done
      sleep 0.25
    done
  ) &
  WATCHER_PID=$!
}

cleanup() {
  rm -f "$PAIR_FILE" "$REVOKED_FLAG" "$WEB_DOWN_FLAG" "$EVE_DOWN_FLAG" "$STUB_UP_FLAG"
  [ -n "$WATCHER_PID" ] && kill "$WATCHER_PID" 2>/dev/null || true
  rm -f /tmp/ub-shots/.hold-* /tmp/ub-shots/.done-* 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  [ -n "$EVE_KILLED" ] && start_eve || true
}
trap cleanup EXIT

# The stall stub: accepts loopback connections and never answers, so the
# session exchange holds the "Connecting" state long enough to capture.
start_stub() {
  "$NODE" -e "require('net').createServer(s=>s.on('data',()=>{})).listen($STUB_PORT,'127.0.0.1')" &
  STUB_PID=$!
  touch "$STUB_UP_FLAG"
  sleep 0.3
}

# The readiness banner needs a paired app whose Mac stops answering: drop
# the web service (:4320), run the leg, bring it back. The running dev
# process carries UB_* secrets in its env — capture them first so the
# restart keeps the provider session alive.
UB_ENV=""
capture_web_env() {
  local pid
  pid=$(lsof -ti tcp:4320 -sTCP:LISTEN | head -1)
  [ -z "$pid" ] && return 0
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  UB_ENV=$(ps eww -p "$pid" | tr ' ' '\n' | grep '^UB_' | tr '\n' ' ')
}

stop_web() {
  capture_web_env
  WEB_PID=$(lsof -ti tcp:4320 -sTCP:LISTEN | head -1)
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -ti tcp:4320 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  touch "$WEB_DOWN_FLAG"
}

start_web() {
  (cd "$ROOT" && env $UB_ENV UB_ROUTER_CONFIG="${UB_ROUTER_CONFIG:-$HOME/.useful-bot/config.json}" \
    nohup npm run web:dev >/tmp/ub-web.log 2>&1 &)
  for _ in $(seq 1 90); do
    lsof -ti tcp:4320 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 1
  done
  rm -f "$WEB_DOWN_FLAG"
}

# Runtime-down banner: web stays up but its eve probe (:4321) must fail, so
# kill the daily eve chain. Scoped to the listener on the daily eve port and
# its own ancestors up to the `service.mjs eve` supervisor, so a dev stack's
# eve (another port, another supervisor) is never touched. Same env-capture
# dance as web.
EVE_ENV=""
stop_eve() {
  local sup="" pid chain="" p hops=0
  pid=$(lsof -ti tcp:4321 -sTCP:LISTEN | head -1)
  p="$pid"
  while [ -n "$p" ] && [ "$p" != "1" ] && [ "$hops" -lt 6 ]; do
    chain="$chain $p"
    if ps -o command= -p "$p" 2>/dev/null | grep -q "service.mjs eve"; then
      sup="$p"
      break
    fi
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    hops=$((hops + 1))
  done
  if [ -n "$sup" ]; then
    EVE_ENV=$(ps eww -p "$sup" | tr ' ' '\n' | grep '^UB_' | tr '\n' ' ')
    # Supervisor first so it cannot restart what is killed next.
    kill "$sup" 2>/dev/null || true
    for p in $chain; do
      [ "$p" != "$sup" ] && kill "$p" 2>/dev/null || true
    done
  else
    # No supervisor above the listener: stop the listener itself and nothing else.
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 20); do
    lsof -ti tcp:4321 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  touch "$EVE_DOWN_FLAG"
  EVE_KILLED=1
}

start_eve() {
  (cd "$ROOT" && env $EVE_ENV UB_ROUTER_CONFIG="${UB_ROUTER_CONFIG:-$HOME/.useful-bot/config.json}" \
    nohup /usr/local/bin/node scripts/service.mjs eve >/tmp/ub-eve.log 2>&1 &)
  for _ in $(seq 1 90); do
    lsof -ti tcp:4321 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 1
  done
  rm -f "$EVE_DOWN_FLAG"
  EVE_KILLED=""
}

# The enrolled credential is the fixture: pair if nothing is live yet.
if ! payload >/dev/null 2>&1; then
  echo "no live phone credential — enrolling (--pair-phone)"
  "$NODE" scripts/setup-local.mjs --pair-phone --host http://127.0.0.1:4320
fi

# Leg A: pair, sign out, sign in — against the live credential.
payload > "$PAIR_FILE"
start_secure_watcher
leg testA_PairAndSessionLifecycle

# The 600 ms "Connected to <name>" success line needs UB_HOLD_CONNECTED to
# hold it still for the visual gate; pairs fresh, so it wants a live token.
leg testConnectedPairScreen ShotsUITests
wait_banked paired
leg testConnectedPairScreenAccessibility ShotsUITests
wait_banked paired

# Between legs: revoke. Relaunched, the stored token is a terminal 401.
"$NODE" scripts/setup-local.mjs --revoke-phone >/dev/null
touch "$REVOKED_FLAG"
leg testB_RevokedCredentialInvalidates
wait_banked credentialInvalid
leg testCredentialInvalid ShotsUITests
rm -f "$REVOKED_FLAG"

# Rotate mints a fresh token (and re-enables phone access); leg C re-pairs it.
"$NODE" scripts/setup-local.mjs --rotate-phone >/dev/null
payload > "$PAIR_FILE"
leg testC_RePairAfterRotation
wait_banked paired
leg testRepairedDark ShotsUITests

# Loading/empty list states: env seams hold or empty the roster fetch; the
# app stays paired underneath either way.
leg testBotsLoading ShotsUITests
leg testBotsEmpty ShotsUITests
leg testBotsLoadError ShotsUITests
leg testBotsLoadErrorAccessibility ShotsUITests
# §11's fourth banner row: the credential expiry override puts the pairing
# inside the seven-day window for the one-time "Pairing expires" banner.
leg testExpiryBanner ShotsUITests

# Visual-gate legs while the pairing + payload are still live: the paired
# journey (Bots, Devices, sign out, sign in) in dark and at XXXL.
leg testJourneyLight ShotsUITests
wait_banked paired
leg testJourneyDark ShotsUITests
wait_banked paired
# The Unpair confirm evidences while the app is still paired.
leg testUnpairConfirm ShotsUITests
wait_banked paired
leg testJourneyAccessibilityLight ShotsUITests
wait_banked paired
leg testJourneyAccessibilityDark ShotsUITests
wait_banked paired

# Readiness banners: the paired app is left on the sim from the journeys.
# No network first (UB_OFFLINE pins the monitor), then web down for "Your
# Mac is unreachable" — and inside that window, the signed-out error and
# offline shots (sign-out is offline-pure by spec). Resign before eve-down
# so the runtime-down leg still launches a paired app.
leg testOfflineBanner ShotsUITests
stop_web
leg testMacUnreachableBanner ShotsUITests
leg testSignedOutStates ShotsUITests
wait_banked signedOut
start_web
leg testResignIn ShotsUITests
wait_banked paired
stop_eve
leg testRuntimeDownBanner ShotsUITests
start_eve

# Connecting / failed states: the stall stub holds the exchange open, then
# a dead loopback port fails it. No live credential needed.
start_stub
leg testConnectingBothAppearances ShotsUITests
kill "$STUB_PID" 2>/dev/null || true
STUB_PID=""
rm -f "$STUB_UP_FLAG"
leg testConnectFailedBothAppearances ShotsUITests

# Offline pairing screen: "You're offline" + disabled-with-reason chrome.
leg testOfflinePairing ShotsUITests

# The PR-1 pairing-shot suite still owns the pairing-empty/manual/camera-
# denied captures — run it last (it leaves the store unpaired) so those
# files in the audit dir always come from the code under test.
leg testPairingLight PairingUITests
leg testPairingDark PairingUITests
leg testPairingAccessibilityLight PairingUITests
leg testPairingAccessibilityDark PairingUITests
leg testPairingCameraDeniedLight PairingUITests
leg testPairingCameraDeniedDark PairingUITests
leg testPairingCameraDeniedAccessibilityLight PairingUITests
leg testPairingCameraDeniedAccessibilityDark PairingUITests

# Filled-token states capture through the framebuffer watcher (XCTest
# censors secure-field content): manual-ready, manual-failed on the
# pushed screen, at standard and XXXL sizes.
leg testManualReadyHold PairingUITests
leg testManualReadyHoldAccessibility PairingUITests
leg testManualFailedHold PairingUITests

rm -f "$PAIR_FILE"

echo "pairing gate: all legs passed"
