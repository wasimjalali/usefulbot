#!/bin/sh
# Builds the real macOS face view (BotFaceLayer.swift) with the core face
# files into an offscreen harness, switches poses, hops, and samples the
# live presentation transforms every 1/60 s. Run from the repo root:
#   sh evals/results/2026-09-28-pr2-bot-face/harness/run.sh
set -eu
H="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"
cp macos/Sources/UsefulBotCore/BotFaceGeometry.swift macos/Sources/UsefulBotCore/BotFaceMotion.swift macos/Sources/UsefulBotApp/BotFaceLayer.swift "$H/main.swift" "$H/stubs.swift" "$W/"
sed -i '' 's/^import UsefulBotCore//' "$W/BotFaceLayer.swift"
sed -i '' "s#/Users/wasimjalali/Desktop/useful-bot/brand#$(pwd)/brand#" "$W/stubs.swift"
swiftc -swift-version 5 -O "$W"/stubs.swift "$W"/BotFaceGeometry.swift "$W"/BotFaceMotion.swift "$W"/BotFaceLayer.swift "$W"/main.swift -o "$W/harness"
"$W/harness"
