#!/usr/bin/env python3
"""Check one cold-start run: new sessions, their bot block and any refusal.

usage: cold-check.py <start UTC iso> <end UTC iso> <out.json> <instructions marker>
Reads ~/Library/Logs/UsefulBotDev/service-{web,router,eve}.log and probe-cold/.
- new sessions: the override's {"coldstart_override": mode, "session": id} lines (web log)
- per session: its router requests (upstream_usage, by sessionId) and the first
  request's probe dump (matched by time), which must carry the bot block
  ("Your bot" section with Test Bot's instructions)
- refusals: bot_context_missing / bot_context_refused / bot_claim_missing /
  session_unbound / session_bind_failed lines in any log, in the window
"""
import glob, json, os, re, sys

start, end, out, marker = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
from datetime import datetime, timedelta
LOGS = os.path.expanduser("~/Library/Logs/UsefulBotDev")
HERE = os.path.dirname(os.path.abspath(__file__))
REFUSALS = ["bot_context_missing", "bot_context_refused", "bot_claim_missing", "session_unbound", "session_bind_failed"]


def lines(name):
    with open(os.path.join(LOGS, name), errors="replace") as f:
        return f.readlines()


def in_window(t):
    return start <= t <= end


# The web log has no timestamps on the override lines; the binding store's
# createdAt places each session in the window.
created = []
for l in lines("service-web.log"):
    m = re.search(r'\{"coldstart_override":"(\w+)","session":"([^"]+)"\}', l)
    if m:
        created.append({"mode": m.group(1), "session": m.group(2)})

owners = json.load(open(os.path.expanduser("~/.useful-bot-dev-app/session-owners.json")))["sessions"]
dumps = sorted(glob.glob(os.path.join(HERE, "probe-cold", "*.json")))


def dump_time(p):
    b = os.path.basename(p)[:24]  # 2026-10-03T23-04-56-123Z
    return b[:13] + ":" + b[14:16] + ":" + b[17:19] + "." + b[20:23] + "Z"


seen = set()
sessions = []
for c in created:
    o = owners.get(c["session"])
    if c["session"] in seen or not o or not in_window(o["createdAt"]):
        continue
    seen.add(c["session"])
    sessions.append({**c, "boundAt": o["createdAt"], "botId": o["botId"]})
sessions.sort(key=lambda s: s["boundAt"])

rows = []
for i, s in enumerate(sessions):
    nxt = sessions[i + 1]["boundAt"] if i + 1 < len(sessions) else end
    # This session's requests: dumps from 10 s before its binding (the first
    # turn may start before the binding exists) to the next session's binding.
    lo = (datetime.fromisoformat(s["boundAt"].replace("Z", "+00:00")) - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"
    # Not before the previous session's binding, so a late request of the
    # previous session is never taken as this one's first.
    if i > 0:
        lo = max(lo, sessions[i - 1]["boundAt"])
    mine = [p for p in dumps if lo <= dump_time(p) < nxt]
    p = mine[0] if mine else None
    sys_text = ""
    if p:
        d = json.load(open(p))
        sys_text = "".join(m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])
                           for m in d["messages"] if m["role"] == "system")
    rows.append({
        "session": s["session"], "mode": s["mode"], "boundAt": s["boundAt"], "requests": len(mine),
        "first_dump": os.path.basename(p) if p else None,
        "has_your_bot": "Your bot" in sys_text,
        "has_instructions": marker in sys_text,
    })

refusals = []
for name in ("service-web.log", "service-router.log", "service-eve.log"):
    for l in lines(name):
        if any(r in l for r in REFUSALS):
            t = re.search(r'"time":"([^"]+)"', l)
            if not t or in_window(t.group(1)):
                refusals.append({"log": name, "line": l.strip()[:300]})

result = {"window": [start, end], "new_sessions": len(rows),
          "all_first_requests_carry_bot_block": all(r["has_your_bot"] and r["has_instructions"] for r in rows),
          "sessions": rows, "refusal_lines": refusals}
json.dump(result, open(out, "w"), indent=1)
print(json.dumps({k: v for k, v in result.items() if k != "sessions"}, indent=1)[:2000])
for r in rows:
    print(r["mode"], r["session"][:12], r["requests"], r["has_your_bot"], r["has_instructions"])
