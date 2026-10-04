#!/usr/bin/env python3
"""Drive the UB-009 PR C behaviour eval in Useful Bot Dev.

Sends every scenario of behavior-scenarios.json, in order, to one bot through
the macOS app (cua-driver in the background, no pointer or focus), waits for
the turn, declines any approval card that appears so the run keeps moving, and
logs what it did. Replies and tool calls are read afterwards from the router's
payload probe dumps (UB_PAYLOAD_PROBE_DIR), by summarize-behavior.py.

usage: run-behavior.py <bot name> <log.jsonl> [ub.py path]
"""
import json, subprocess, sys, time, os

HERE = os.path.dirname(os.path.abspath(__file__))
bot, log_path = sys.argv[1], sys.argv[2]
UB = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "ub.py")
scenarios = json.load(open(os.path.join(HERE, "behavior-scenarios.json")))
MAX_TURN = 240
CARD_WORDS = ["Deny", "Don't allow", "Decline", "Reject"]

def ub(steps):
    r = subprocess.run(["python3", UB, json.dumps(steps)], capture_output=True, text=True, timeout=300)
    return r.stdout + r.stderr

def decline_cards():
    out = ub([{"op": "find", "q": "AXButton"}])
    for word in CARD_WORDS:
        if f"| {word}" in out:
            ub([{"op": "click", "q": word}])
            return word
    return None

def stop_visible():
    return "AXButton | Stop" in ub([{"op": "find", "q": "Stop"}])

def send(text):
    return ub([
        {"op": "click", "q": bot}, {"op": "wait", "s": 1},
        {"op": "type", "q": "AXTextArea", "text": text}, {"op": "wait", "s": 0.5},
        {"op": "click", "q": "Send"},
    ])

with open(log_path, "a") as log:
    items = scenarios["scenarios"] + [{"id": "END", "cat": "closing", "text": "Reply with the single word done."}]
    for s in items:
        started = time.time()
        out = send(s["text"])
        declined = []
        # Wait for the turn to end: the composer shows "Stop" while it runs.
        # Decline any card on the way so the run keeps moving. Cap at 4 minutes.
        time.sleep(4)
        while time.time() - started < MAX_TURN:
            word = decline_cards()
            if word:
                declined.append(word)
            if not stop_visible():
                break
            time.sleep(4)
        log.write(json.dumps({"id": s["id"], "sent_at": started, "send_ok": "click AXButton AXButton | Send" in out,
                              "declined_cards": declined, "seconds": round(time.time() - started, 1)}) + "\n")
        log.flush()
        print(s["id"], "declined" if declined else "", flush=True)
