#!/usr/bin/env python3
"""Send a scripted list of turns to one bot in Useful Bot Dev and wait for each.

Drives the macOS app in the background with cua-driver (ub.py), the same way as
the PR C behaviour run (2026-10-02-ub009-prc/run-behavior.py): select the bot,
type, press Send, then wait until the composer stops showing "Stop". Any
approval card is declined so the run keeps moving, unless the turn sets
"approve": true. Refuses to send unless the dev store's selected bot is the
named bot, checked before every turn.

usage: run-turns.py <bot name> <turns.json> <log.jsonl> [max seconds per turn]
turns.json: {"turns": [{"id": "A1", "text": "...", "approve": false}, ...]}
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
UB = os.path.join(HERE, "..", "2026-10-02-ub009-prc", "ub.py")
SHELL = os.path.expanduser("~/.useful-bot-dev-app/shell.json")
bot, turns_path, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
MAX_TURN = int(sys.argv[4]) if len(sys.argv) > 4 else 240
DENY = ["Deny", "Don't allow", "Decline", "Reject"]
ALLOW = ["Allow", "Approve", "Allow once", "Confirm"]


def ub(steps):
    r = subprocess.run(["python3", UB, json.dumps(steps)], capture_output=True, text=True, timeout=300)
    return r.stdout + r.stderr


def selected_is_bot():
    d = json.load(open(SHELL))
    named = [b for b in d["bots"] if b["name"] == bot]
    return len(named) == 1 and d.get("selectedBotId") == named[0]["id"]


def answer_cards(approve):
    out = ub([{"op": "find", "q": "AXButton"}])
    for word in (ALLOW if approve else DENY):
        if f"| {word} " in out or out.rstrip().endswith(f"| {word}"):
            ub([{"op": "click", "q": word}])
            return word
    return None


def stop_visible():
    return "AXButton | Stop" in ub([{"op": "find", "q": "Stop"}])


turns = json.load(open(turns_path))["turns"]
with open(log_path, "a") as log:
    for t in turns:
        ub([{"op": "click", "q": bot}, {"op": "wait", "s": 1}])
        if not selected_is_bot():
            raise SystemExit(f"refusing to send {t['id']}: selected bot is not {bot}")
        started = time.time()
        out = ub([
            {"op": "type", "q": "AXTextArea", "text": t["text"]}, {"op": "wait", "s": 0.5},
            {"op": "click", "q": "Send"},
        ])
        answered = []
        time.sleep(4)
        while time.time() - started < MAX_TURN:
            word = answer_cards(t.get("approve", False))
            if word:
                answered.append(word)
            if not stop_visible():
                break
            time.sleep(4)
        rec = {"id": t["id"], "sent_at": started, "send_ok": "click AXButton AXButton | Send" in out,
               "cards": answered, "seconds": round(time.time() - started, 1),
               "timed_out": time.time() - started >= MAX_TURN}
        log.write(json.dumps(rec) + "\n")
        log.flush()
        print(json.dumps(rec), flush=True)
