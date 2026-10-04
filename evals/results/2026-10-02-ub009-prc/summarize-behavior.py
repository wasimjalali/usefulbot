#!/usr/bin/env python3
"""Turn the payload probe dumps of one behaviour run into a per-scenario table.

Finds the last dump whose system message names the bot ("You are <bot>."),
walks its message history, and for each scenario collects the tool calls and
the final assistant reply that followed the owner's message. Also records the
fixed envelope of the first dump of that bot: system characters, tool count and
schema characters.

usage: summarize-behavior.py <probe dir> <bot name> <out.json>
"""
import glob, json, os, sys

probe_dir, bot, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
scenarios = json.load(open(os.path.join(HERE, "behavior-scenarios.json")))["scenarios"]
by_text = {s["text"]: s for s in scenarios}

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""

def owner_text(raw):
    # Hidden app notes come first, then a blank line, then the owner's words;
    # the app may add more after them, so match the scenario text anywhere.
    for s in sorted(scenarios, key=lambda x: -len(x["text"])):
        if s["text"] in raw:
            return s["text"]
    return None

dumps = []
for path in sorted(glob.glob(os.path.join(probe_dir, "*.json"))):
    body = json.load(open(path))
    body = body.get("body", body)
    msgs = body.get("messages", [])
    system = "\n".join(text_of(m.get("content")) for m in msgs if m.get("role") == "system")
    if f"You are {bot}." not in system:
        continue
    dumps.append((path, body, msgs, system))
if not dumps:
    sys.exit(f"no dumps for {bot}")

first = dumps[0]
tools = first[1].get("tools", [])
envelope = {
    "system_chars": len(first[3]),
    "tools": len(tools),
    "tool_schema_chars": len(json.dumps(tools)),
    "requests": len(dumps),
}

last_msgs = dumps[-1][2]
rows, current = [], None
for m in last_msgs:
    role = m.get("role")
    if role == "user":
        t = owner_text(text_of(m.get("content")))
        if t:
            current = {"id": by_text[t]["id"], "cat": by_text[t]["cat"], "prompt": t, "tool_calls": [], "reply": ""}
            rows.append(current)
            continue
    if current is None:
        continue
    if role == "assistant":
        for call in m.get("tool_calls") or []:
            fn = call.get("function", {})
            current["tool_calls"].append({"name": fn.get("name"), "args": (fn.get("arguments") or "")[:300]})
        reply = text_of(m.get("content"))
        if reply.strip():
            current["reply"] = reply.strip()

json.dump({"bot": bot, "envelope": envelope, "rows": rows}, open(out_path, "w"), indent=1)
print(json.dumps(envelope))
for r in rows:
    calls = ",".join(c["name"] or "?" for c in r["tool_calls"]) or "-"
    print(f'{r["id"]:3} {calls[:40]:40} {r["reply"][:90]!r}')
