#!/bin/sh
# Swift test needs a framework search path for the Testing framework. The
# Command Line Tools keep it outside the SDK; Xcode users get it by default.
# Testing.framework links lib_TestingInterop through @rpath, so both get
# copied next to the test bundle before running.
set -eu
cd "$(dirname "$0")"
sh ./test-build-guard.sh
CLT="/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
XCODE="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks"
FRAMEWORKS=""
if [ -d "$XCODE" ]; then
  FRAMEWORKS="$XCODE"
elif [ -d "$CLT" ]; then
  FRAMEWORKS="$CLT"
fi
if [ -n "$FRAMEWORKS" ]; then
  # The interop dylib lives under the same Developer root as Testing.framework
  # but Xcode and the Command Line Tools lay that root out differently: the
  # CLT keeps usr/lib under Library/Developer, while Xcode keeps it beside
  # Library (Developer/usr/lib). Probe both layouts plus the default toolchain
  # rather than assuming one, and report every path checked when none match.
  INTEROP_PATHS="
$(dirname "$FRAMEWORKS")/usr/lib/lib_TestingInterop.dylib
$(dirname "$(dirname "$FRAMEWORKS")")/usr/lib/lib_TestingInterop.dylib
/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/lib_TestingInterop.dylib
"
  INTEROP=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate" ]; then
      INTEROP="$candidate"
      break
    fi
  done <<EOF
$INTEROP_PATHS
EOF
  if [ ! -f "$FRAMEWORKS/Testing.framework/Versions/A/Testing" ]; then
    echo "test.sh: Testing.framework missing under $FRAMEWORKS" >&2
    exit 1
  fi
  if [ -z "$INTEROP" ]; then
    echo "test.sh: lib_TestingInterop.dylib not found; checked:" >&2
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      echo "  $candidate" >&2
    done <<EOF
$INTEROP_PATHS
EOF
    exit 1
  fi
  swift build --build-tests \
    -Xswiftc -F -Xswiftc "$FRAMEWORKS" \
    -Xlinker -rpath -Xlinker "$FRAMEWORKS"
  BIN_DIR="$(swift build --show-bin-path --build-tests)"
  cp -R "$FRAMEWORKS/Testing.framework" "$BIN_DIR/"
  cp "$INTEROP" "$BIN_DIR/"
  exec swift test --skip-build \
    -Xswiftc -F -Xswiftc "$FRAMEWORKS" \
    -Xlinker -rpath -Xlinker "$FRAMEWORKS" \
    "$@"
fi
exec swift test "$@"
