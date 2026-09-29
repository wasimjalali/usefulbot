#!/bin/sh
# The performance regression guard. See perf/README.md.
#   perf/run.sh check [--quick]   measure and compare to budgets.json (exit 1 on a breach)
#   perf/run.sh baseline          measure and propose budgets
#   perf/run.sh fixtures | lock   build or re-lock the frozen fixture chats
set -eu
cd "$(dirname "$0")"
mkdir -p .build
if [ ! -x .build/perfrec ] || [ tools/perfrec.swift -nt .build/perfrec ]; then
  swiftc -O tools/perfrec.swift -o .build/perfrec
fi
exec python3 runner/perfguard.py "$@"
