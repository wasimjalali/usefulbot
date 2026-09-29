#!/bin/bash
# usage: coldopen.sh <outDir> [install]
OUT="$1"; mkdir -p "$OUT"
APP="/Applications/Useful Bot.app"
osascript -e 'tell application id "ai.useful.bot" to quit' >/dev/null 2>&1
for i in $(seq 1 40); do pgrep -f "$APP/Contents/MacOS/" >/dev/null || break; sleep 0.25; done
if [ "$2" = install ]; then (cd /Users/wasimjalali/Desktop/useful-bot && npm run install:app >"$OUT/install.log" 2>&1) || { echo install failed; exit 1; }; fi
sleep 2
T0=$(python3 -c 'import time;print(time.time())')
open -g "$APP"
WID=""
for i in $(seq 1 200); do
  WID=$(cd ~ && cua-driver call list_windows '{}' 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit()
for w in d['windows']:
  if w['app_name']=='Useful Bot' and w['title']=='Useful Bot' and w['bounds']['height']>400: print(w['window_id']); break")
  [ -n "$WID" ] && break; sleep 0.05
done
T1=$(python3 -c 'import time;print(time.time())')
echo "launch->window ${WID}: $(python3 -c "print(round($T1-$T0,2))") s" | tee "$OUT/timing.txt"
winrec "$WID" 16 "$OUT/frames" 60 >"$OUT/winrec.log" 2>&1
echo done
