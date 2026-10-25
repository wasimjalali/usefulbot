#!/usr/bin/env python3
"""Golden eval harness for Useful Bot's one bot. Drives Useful Bot Dev's UI, so it is engine-neutral.

    python3 evals/golden/run.py --engine eve --run-id 2026-10-25-eve
    python3 evals/golden/run.py --engine eve --only t02,t03        # a subset
    python3 evals/golden/run.py --engine eve --dry-run             # walk the UI, send nothing

Python 3 stdlib only, plus ~/.local/bin/cua-driver (background only: accessibility tokens, never the
real pointer, focus or keyboard). It talks to ~/Applications/Useful Bot Dev.app and refuses the daily
app. See README.md for what is measured and the rules; tasks.json for the ten tasks.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
CUA = os.path.join(HOME, ".local/bin/cua-driver")
DEV_STATE = os.path.join(HOME, ".useful-bot-dev-app")
APP_NAME = "Useful Bot Dev"
DEFAULT_SCRATCH = os.path.join(HOME, "UsefulBotGolden")

IDLE_SECONDS = 3.0        # no working row, no Stop button, no card, for this long in a row
IDLE_MIN_SAMPLES = 3      # ... and at least this many consecutive samples
TURN_LIMIT_S = 360.0      # hard limit per turn
START_GRACE_S = 15.0      # a turn that never shows work may be declared idle after this long
POLL_S = 1.0

# Effort words the model popover can offer, lowest to highest.
EFFORT_ORDER = ["Minimal", "Low", "Medium", "High", "XHigh", "Extra high", "Max"]

# Labels of the working row (TurnActivity.label in the app) plus its step forms. The row has no
# role we can rely on, so it is matched by label, and only on nodes that carry no text value.
WORK_RE = re.compile(
    r"^(Thinking|Writing|Compacting the conversation|Planning|Running a command|Using a connector|"
    r"Looking through connectors|Writing a routine|Removing a routine|Setting up a tool|Reading a folder|"
    r"Checking the routines|Reading memory|Searching memory|Saving to memory|Drafting a proposal|"
    r"Looking through connections|Reading a file|Running a routine|Updating a routine|Searching the web|"
    r"Writing a file|Working|Using .+)(: .*)?( · .*)?$"
)
UI_STRINGS = {"Today", "Yesterday"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Refuse(Exception):
    """A precondition failed: print it and stop before touching anything."""


# --------------------------------------------------------------------------- cua-driver

def refusal_code(r):
    """The refusal code of an action result, or None. cua-driver 0.38 puts it at the top level next to
    effect "refused"; older versions nested it under "refusal" or set status "refused"."""
    if r.get("refusal"):
        ref = r["refusal"]
        return (ref.get("code") if isinstance(ref, dict) else None) or "refused"
    if r.get("effect") == "refused" or r.get("status") == "refused":
        return r.get("code") or "refused"
    return None


class Driver:
    def __init__(self, session):
        self.session = session
        self.pid = None
        self.window_id = None

    def call(self, tool, args, timeout=90):
        p = subprocess.run([CUA, "call", tool, json.dumps(args)], capture_output=True, text=True,
                           cwd=HOME, timeout=timeout)
        try:
            return json.loads(p.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"cua-driver {tool}: not JSON: {p.stdout[:200]!r} {p.stderr[:200]!r}")

    def find_window(self):
        d = self.call("list_windows", {})
        cands = [w for w in d.get("windows", [])
                 if w.get("app_name") == APP_NAME and w.get("title") == APP_NAME]
        if not cands:
            raise Refuse(f"no window titled '{APP_NAME}': is Useful Bot Dev running? (open -g ~/Applications/'Useful Bot Dev.app')")
        cands.sort(key=lambda w: (w.get("is_on_screen", False), w["bounds"]["width"] * w["bounds"]["height"]), reverse=True)
        w = cands[0]
        self.pid, self.window_id = w["pid"], w["window_id"]
        return w

    def snapshot(self, shot=None, tries=5):
        args = {"pid": self.pid, "window_id": self.window_id, "session": self.session,
                "max_elements": 30000, "include_screenshot": False, "timeout_ms": 8000,
                "tree_format": "both"}  # since cua-driver 0.38 a read returns only the markdown unless asked
        if shot:
            args["screenshot_out_file"] = shot
            args["max_image_dimension"] = 1400
        last = None
        for i in range(tries):
            try:
                d = self.call("get_window_state", args)
            except Exception as e:  # a timed-out or empty walk after idle minutes: retry
                last = e
                time.sleep(1)
                continue
            if d.get("elements") and len(d["elements"]) >= 5 and d.get("tree_markdown"):
                return Snap(d)
            last = RuntimeError(f"empty AX walk: {str(d)[:200]}")
            time.sleep(1)
        raise RuntimeError(f"no usable AX snapshot after {tries} tries: {last}")

    def click(self, snap, el):
        r = self.call("click", {"pid": self.pid, "window_id": self.window_id, "session": self.session,
                                "element_token": el["element_token"]})
        return r

    def press(self, label=None, role="AXButton", retries=3, predicate=None):
        """Fresh snapshot, click the element with this label. A stale token re-snapshots and retries."""
        for _ in range(retries):
            snap = self.snapshot()
            el = snap.find(label=label, role=role, predicate=predicate)
            if el is None:
                raise RuntimeError(f"no {role} labelled {label!r} in the window")
            r = self.click(snap, el)
            if refusal_code(r) == "stale_element_token":
                continue
            if refusal_code(r):
                raise RuntimeError(f"click {label!r} refused: {r}")
            return r
        raise RuntimeError(f"click {label!r}: token kept going stale")

    def type_text(self, snap, el, text):
        return self.call("type_text", {"pid": self.pid, "window_id": self.window_id, "session": self.session,
                                       "element_token": el["element_token"], "text": text})

    def set_value(self, el, value):
        return self.call("set_value", {"pid": self.pid, "window_id": self.window_id,
                                       "element_token": el["element_token"], "value": value})

    def end(self):
        try:
            self.call("end_session", {"session": self.session}, timeout=15)
        except Exception:
            pass


class Snap:
    """One accessibility walk: structured elements (tokens) plus the parsed markdown tree (all text)."""
    LINE = re.compile(r"^(?P<ind>\s*)- (?:\[(?P<idx>\d+)\] )?(?P<role>AX\w+)(?P<rest>.*)$")

    def __init__(self, d):
        self.d = d
        self.elements = d["elements"]
        self.nodes = self.parse(d["tree_markdown"])
        # Only indexed (actionable) elements carry a frame; a bot paragraph has the Copy action, so it has one.
        by_idx = {e.get("element_index"): e for e in self.elements}
        for n in self.nodes:
            fr = (by_idx.get(n["idx"]) or {}).get("frame") if n["idx"] is not None else None
            n["frame"] = fr

    @staticmethod
    def parse(md):
        """One node per tree line. A text value can span several lines (a code block, a bash command), and
        so can an action list, so any line that does not start a node belongs to the node before it."""
        recs = []
        for line in md.split("\n"):
            m = Snap.LINE.match(line)
            if m:
                recs.append([m, []])
            elif recs:
                recs[-1][1].append(line)
        nodes = []
        for m, extra in recs:
            rest = m["rest"] + ("\n" + "\n".join(extra) if extra else "")
            n = {"depth": len(m["ind"]) // 2, "idx": int(m["idx"]) if m["idx"] else None,
                 "role": m["role"], "label": None, "value": None, "id": None, "copy": False}
            v = re.match(r' = "(.*?)"(?= \[(?:id=|actions=|help=)|$)', rest, re.S)
            tail = rest
            if v:
                n["value"] = v.group(1)
                tail = rest[v.end():]
                n["copy"] = "name:copy" in tail
            else:
                lab = re.match(r" \((.*?)\)(?= \[|$)", rest, re.S)
                if lab:
                    n["label"] = lab.group(1)
            ident = re.search(r"\[id=([^\s\]]+)", tail)
            if ident:
                n["id"] = ident.group(1)
            # a child that repeats its parent's text is the same text, not a second line
            if (n["value"] is not None and nodes and nodes[-1]["value"] == n["value"]
                    and nodes[-1]["depth"] == n["depth"] - 1):
                continue
            nodes.append(n)
        return nodes

    def find(self, label=None, role=None, predicate=None):
        for e in self.elements:
            if label is not None and e.get("label") != label:
                continue
            if role is not None and e.get("role") != role:
                continue
            if predicate is not None and not predicate(e):
                continue
            return e
        return None

    def has_button(self, label):
        return any(n["role"] == "AXButton" and n["label"] == label for n in self.nodes)

    def element_by_idx(self, idx):
        for e in self.elements:
            if e.get("element_index") == idx:
                return e
        return None

    # ---- what the transcript and cards say

    def texts(self):
        """Depth-1 static texts in tree order: [{'text', 'bot', 'y', 'x', 'code'}]. bot = it carries the Copy
        action. y and x are the element frame when the tree gives one. A text with no frame (a code block, a
        user bubble) takes the position of the last framed node before it (a code block follows its 'Copy
        code' button). code = the text sits right after a 'Copy code' button."""
        out = []
        last = (0.0, 0.0)
        after_copy_code = False
        for n in self.nodes:
            fr = n.get("frame")
            if fr:
                last = (fr["y"], fr["x"])
            if n["role"] == "AXButton":
                after_copy_code = n["label"] == "Copy code"
            if n["role"] == "AXStaticText" and n["value"] is not None and n["depth"] == 1:
                out.append({"text": n["value"], "bot": n["copy"], "y": fr["y"] if fr else last[0] + 0.01,
                            "x": fr["x"] if fr else last[1], "framed": bool(fr), "code": after_copy_code and not fr})
                after_copy_code = False
        return out

    def working_label(self):
        for n in self.nodes:
            if (n["role"] not in ("AXButton", "AXMenuItem", "AXMenuBarItem", "AXMenu", "AXWindow")
                    and n["value"] is None and n["label"] and WORK_RE.match(n["label"])):
                return n["label"]
        return None

    def approval_cards(self):
        """[{tool, preview, texts}] for each open approval card, read off the static text between the
        'Needs approval' heading and the Deny button."""
        cards = []
        ns = self.nodes
        for i, n in enumerate(ns):
            if n["role"] == "AXStaticText" and n["value"] == "Needs approval":
                texts = []
                for m in ns[i + 1:]:
                    if m["role"] == "AXButton" and (m["id"] == "approval-deny" or m["label"] == "Deny"):
                        break
                    if m["role"] == "AXButton" and m["id"] == "approval-open-chat":
                        continue
                    if m["role"] == "AXStaticText" and m["value"] is not None:
                        texts.append(m["value"])
                    if len(texts) > 12:
                        break
                # texts[0] is the tool name; everything after it up to Deny is what the owner is approving
                # (a command, a path and a body). "From another chat" lines are not part of it.
                body = [t for t in texts[1:] if not t.startswith("From another chat")]
                cards.append({"tool": texts[0] if texts else "", "preview": "\n".join(body), "texts": texts})
        return cards

    def question_cards(self):
        cards = []
        ns = self.nodes
        for i, n in enumerate(ns):
            if n["role"] == "AXStaticText" and n["value"] and n["value"].endswith(" asks") and n["depth"] == 1:
                texts, opts = [], []
                for m in ns[i + 1:]:
                    if m["role"] == "AXButton" and m["id"] == "question-option":
                        opts.append(m["label"])
                    elif m["role"] == "AXButton":
                        break
                    elif m["role"] == "AXStaticText" and m["value"] is not None and m["depth"] == 1 and not opts:
                        texts.append(m["value"])
                cards.append({"heading": n["value"], "texts": texts, "options": opts})
        return cards


# --------------------------------------------------------------------------- app state (read only)

def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def bot_state():
    """The selected bot's permission and model selection, from the dev shell store (read only).
    None if the file is missing or changed shape (the harness then relies on the popover labels)."""
    d = read_json(os.path.join(DEV_STATE, "shell.json"))
    try:
        sel = d["selectedBotId"]
        bot = next(b for b in d["bots"] if b["id"] == sel and not b.get("archived"))
        return {"bot_id": sel, "permission": bot.get("permission"), "model": bot.get("model")}
    except Exception:
        return None


def memory_snapshot():
    root = os.path.join(DEV_STATE, "memory", "notes")
    out = {}
    if os.path.isdir(root):
        for dp, _, fns in os.walk(root):
            for fn in fns:
                p = os.path.join(dp, fn)
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                    out[os.path.relpath(p, root)] = {"mtime_ns": os.stat(p).st_mtime_ns,
                                                     "sha": hashlib.sha256(data).hexdigest(),
                                                     "text": data.decode("utf-8", "replace")}
                except OSError:
                    pass
    return out


def routines_snapshot():
    d = read_json(os.path.join(DEV_STATE, "routines.json")) or {}
    return {r["id"]: r for r in d.get("routines", []) if isinstance(r, dict) and "id" in r}


def tree_hashes(root):
    out = {}
    for dp, _, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            with open(p, "rb") as f:
                out[os.path.relpath(p, root)] = hashlib.sha256(f.read()).hexdigest()
    return out


# --------------------------------------------------------------------------- preflight and chips

def screen_locked():
    p = subprocess.run(["ioreg", "-n", "Root", "-d1", "-a"], capture_output=True, text=True)
    m = re.search(r"CGSSessionScreenIsLocked</key>\s*<(true|false)/>", p.stdout)
    return bool(m and m.group(1) == "true")


def check_app_identity(pid):
    cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout.strip()
    if "Useful Bot Dev.app" not in cmd or "/Applications/Useful Bot.app/" in cmd:
        raise Refuse(f"pid {pid} is not Useful Bot Dev.app (command: {cmd[:120]!r}). The daily app is never driven.")
    return cmd


def chip_rows(drv):
    """Open the model chip's popover, read its rows, and close it. Returns (effort, model, efforts)."""
    drv.press("Effort, speed, and model")
    time.sleep(0.6)
    snap = drv.snapshot()
    effort = model = None
    for e in snap.elements:
        lab = e.get("label") or ""
        if _is_effort_row(lab):
            effort = lab[len("Effort, "):]
        if lab.startswith("Model, "):
            model = lab[len("Model, "):]
    efforts = []
    if effort is not None:
        drv.press(f"Effort, {effort}")
        time.sleep(0.6)
        snap = drv.snapshot()
        row = next((i for i, e in enumerate(snap.elements) if _is_effort_row(e.get("label") or "")), None)
        if row is not None:
            for e in snap.elements[max(0, row - 10):row]:
                if e.get("role") == "AXButton" and e.get("label") in EFFORT_ORDER:
                    efforts.append(e["label"])
    close_popovers(drv)
    return effort, model, efforts


CHIP_MODEL = "Effort, speed, and model"


def _is_effort_row(label):
    return label.startswith("Effort, ") and label != CHIP_MODEL


def _popover_open(snap):
    labels = {e.get("label") or "" for e in snap.elements}
    if any(_is_effort_row(l) or l.startswith("Model, ") for l in labels):
        return "Effort, speed, and model"
    if {"Read only", "Auto", "Full access"} <= labels:
        return "What the bot may do on this Mac"
    return None


def close_popovers(drv):
    """One chip press closes the popover. The close animates, so wait for the rows to leave the tree
    before pressing again: a second press during the animation would reopen it."""
    chip = _popover_open(drv.snapshot())
    for _ in range(3):
        if chip is None:
            return
        drv.press(chip)
        end = time.time() + 4
        while time.time() < end:
            time.sleep(0.5)
            if _popover_open(drv.snapshot()) is None:
                return
        chip = _popover_open(drv.snapshot())
    raise RuntimeError("could not close the composer popovers: close the popover in Useful Bot Dev by hand")


def wait_state(pred, seconds=6.0):
    end = time.time() + seconds
    while time.time() < end:
        s = bot_state()
        if s and pred(s):
            return s
        time.sleep(0.4)
    return bot_state()


PERM_LABEL = {"read_only": "Read only", "auto": "Auto", "full_access": "Full access"}


def ensure_permission(drv, need, dry):
    st = bot_state()
    have = st["permission"] if st else None
    if have == need:
        return {"permission": have, "changed": False}
    if dry:
        return {"permission": have, "changed": False, "would_set": need,
                "popover_option_present": _permission_option_present(drv, PERM_LABEL[need])}
    drv.press("What the bot may do on this Mac")
    time.sleep(0.6)
    drv.press(PERM_LABEL[need])
    time.sleep(0.6)
    st2 = wait_state(lambda s: s["permission"] == need)
    close_popovers(drv)
    if not st2 or st2["permission"] != need:
        raise Refuse(f"permission is {st2 and st2['permission']!r}, the task needs {need!r} and the harness could not set it. "
                     f"Set the permission chip to '{PERM_LABEL[need]}' by hand and rerun.")
    return {"permission": need, "changed": True, "was": have}


def _permission_option_present(drv, label):
    drv.press("What the bot may do on this Mac")
    time.sleep(0.6)
    present = drv.snapshot().find(label=label, role="AXButton") is not None
    close_popovers(drv)
    return present


def ensure_model_effort(drv, dry):
    """DeepSeek must already be the model (the harness never switches models); effort goes to the
    highest the chip offers."""
    effort, model, efforts = chip_rows(drv)
    st = bot_state()
    info = {"chip_model": model, "chip_effort": effort, "effort_options": efforts, "shell_model": st and st["model"]}
    if not model or "deepseek" not in model.lower():
        raise Refuse(f"the model chip reads {model!r}, expected a DeepSeek model. Pick DeepSeek V4.1 Flash in the chip and rerun.")
    if not efforts:
        raise Refuse("could not read the effort options from the model chip popover")
    top = max(efforts, key=EFFORT_ORDER.index)
    info["highest_effort"] = top
    if effort == top:
        info["changed"] = False
        return info
    if dry:
        info["would_set"] = top
        return info
    drv.press("Effort, speed, and model")
    time.sleep(0.6)
    drv.press(f"Effort, {effort}")
    time.sleep(0.6)
    drv.press(top)
    time.sleep(0.8)
    close_popovers(drv)
    effort2, _, _ = chip_rows(drv)
    if effort2 != top:
        raise Refuse(f"effort reads {effort2!r} after setting {top!r}. Set it by hand and rerun.")
    info.update({"changed": True, "was": effort, "chip_effort": effort2})
    return info


# --------------------------------------------------------------------------- chat actions

def new_chat(drv):
    drv.press("New chat")
    end = time.time() + 10
    while time.time() < end:
        snap = drv.snapshot()
        texts = snap.texts()
        starter = any(n["id"] == "starter-prompt" for n in snap.nodes)
        content = [t for t in texts if t["bot"]]
        if starter or not content:
            return snap
        time.sleep(0.7)
    raise RuntimeError("New chat did not leave an empty chat open (the transcript still shows messages)")


def composer(snap):
    el = snap.find(role="AXTextArea")
    if el is None:
        raise RuntimeError("no composer text area in the window")
    return el


def type_prompt(drv, text):
    snap = drv.snapshot()
    el = composer(snap)
    r = drv.type_text(snap, el, text)
    if refusal_code(r):
        raise RuntimeError(f"type_text refused: {r}")
    time.sleep(0.5)
    snap = drv.snapshot()
    el = composer(snap)
    got = el.get("value")
    send = snap.find(label="Send", role="AXButton")
    return {"composer_value_matches": got == text if got is not None else None,
            "composer_value_exposed": got is not None, "send_enabled": bool(send and send.get("enabled", True))}


def clear_composer(drv):
    snap = drv.snapshot()
    el = composer(snap)
    r = drv.set_value(el, "")
    if refusal_code(r):
        raise RuntimeError(f"set_value refused: {r}")
    time.sleep(0.4)
    snap = drv.snapshot()
    el2 = composer(snap)
    left = el2.get("value")
    return {"set_value_result": r.get("effect") or r.get("status") or str(r)[:80], "value_after": left}


def send_prompt(drv, text):
    info = type_prompt(drv, text)
    if info["composer_value_matches"] is False:
        raise RuntimeError(f"composer holds different text than the prompt: {info}")
    if not info["send_enabled"]:
        raise RuntimeError(f"Send is not enabled after typing: {info}")
    drv.press("Send")
    return info


def normalise(s):
    return re.sub(r"\s+", " ", s).strip()


def split_turn(texts, prompt, before_bot):
    """The speaker-tagged lines that belong to this turn: everything after the last bubble that
    matches the prompt. If no bubble matches (virtualised rows), the bot lines beyond what was there."""
    want = normalise(prompt)
    pos = None
    for i, t in enumerate(texts):
        if not t["bot"] and normalise(t["text"]) == want:
            pos = i
    if pos is not None:
        tail = texts[pos + 1:]
        found = True
    else:
        bots = [t for t in texts if t["bot"]]
        tail = bots[before_bot:]
        found = False
    tail = [t for t in tail if t["text"] not in UI_STRINGS and not t["text"].startswith("Message ")]
    # The tree does not list a bubble's paragraphs in screen order after a streamed turn (the first
    # paragraph of the last bubble came last), so order by position on screen. sorted() is stable.
    tail = sorted(tail, key=lambda t: (t["y"], t["x"]))
    return tail, found


def render_lines(items):
    out, bullet = [], False
    for t in items:
        if t["text"] == "•":
            bullet = True
            continue
        text = "```\n" + t["text"] + "\n```" if t.get("code") else t["text"]
        out.append(("- " if bullet else "") + text)
        bullet = False
    return "\n".join(out)


def chat_rows(snap):
    return [e for e in (snap.element_by_idx(n["idx"]) for n in snap.nodes
                        if n["id"] == "chat-row" and n["idx"] is not None) if e]


def read_turn(drv, prompt, before_bot, shot):
    """Read the finished turn off the window. A tree read right after a streamed turn has come back cut
    short (t02, t04, t07 of the first baseline), so read until two reads 1.5 s apart give the same reply.
    Never navigate away to force a redraw: on eve, opening another chat swaps the bot's live session, and
    that broke run 2026-10-25-eve-r2 (wrong chat read, multi-turn context lost). Items are ordered by
    their frames in split_turn. Returns (snapshot, tail, found, info)."""
    prev = None
    for n in range(1, 9):
        time.sleep(1.5)
        final = drv.snapshot(shot=shot)
        tail, found = split_turn(final.texts(), prompt, before_bot)
        cur = render_lines(tail)
        if cur == prev and cur:
            info = {"reply_reads": n, "reply_stable": True}
            break
        prev = cur
    else:
        info = {"reply_reads": 8, "reply_stable": False}
    return final, tail, found, info


def run_turn(drv, prompt, policy, shot, turn_no, dry=False):
    pre = drv.snapshot()
    before_bot = len([t for t in pre.texts() if t["bot"]])
    t_send_wall = time.time()
    t_prep = time.monotonic()
    send_info = send_prompt(drv, prompt)
    # The clock starts when the Send click has returned. Typing, the AX walks around it and the click
    # itself (cua-driver animates the agent cursor, about 2.6 s per click) are not the bot's time.
    t0 = time.monotonic()
    rec = {"turn": turn_no, "prompt": prompt, "sent_at_ms": int(t_send_wall * 1000), "activity": [], "cards": [],
           "questions": [], "timeout": False, "never_busy": False, "send": send_info,
           "prep_s": round(t0 - t_prep, 2)}
    busy_seen = False
    first_busy = None
    idle_since = None
    idle_samples = 0
    last_label = None
    handled = set()
    fails = 0
    while True:
        now = time.monotonic()
        if now - t0 > TURN_LIMIT_S:
            rec["timeout"] = True
            try:
                drv.press("Stop")
                rec["stopped_after_timeout"] = True
            except Exception as e:
                rec["stopped_after_timeout"] = f"Stop failed: {e}"
            break
        try:
            snap = drv.snapshot(tries=2)
            fails = 0
        except Exception as e:
            fails += 1
            if fails >= 15:
                raise RuntimeError(f"AX tree unreadable for {fails} polls in a row: {e}")
            time.sleep(POLL_S)
            continue
        stop = snap.find(label="Stop", role="AXButton") is not None
        work = snap.working_label()
        cards = snap.approval_cards()
        for q in snap.question_cards():
            key = ("q", q["heading"], tuple(q["texts"]))
            if key not in handled:
                handled.add(key)
                rec["questions"].append({"t": round(now - t0, 1), **q})
        card_busy = False
        # A card key counts as handled only while that card is still on screen, so the same
        # command raised again later (a retry) is clicked and recorded as a second card.
        showing = {("c", c["tool"], c["preview"]) for c in cards}
        handled = {k for k in handled if k[0] != "c" or k in showing}
        for c in cards:
            card_busy = True
            key = ("c", c["tool"], c["preview"])
            btn_label = "Approve" if policy == "approve" else "Deny"
            btn = snap.find(label=btn_label, role="AXButton")
            if btn is not None and btn.get("enabled", True) and key not in handled:
                handled.add(key)
                rec["cards"].append({"t": round(now - t0, 1), "tool": c["tool"], "preview": c["preview"],
                                     "texts": c["texts"], "decision": policy})
                log(f"  card: {c['tool']!r} {c['preview'][:70]!r} -> {policy}")
                drv.click(snap, btn)
                time.sleep(0.8)
            break  # one card per poll; the next poll sees the rest
        busy = stop or bool(work) or card_busy
        label = work or ("(waiting on a card)" if card_busy else None)
        if label and label != last_label:
            rec["activity"].append({"t": round(now - t0, 1), "label": label})
        last_label = label
        if busy:
            busy_seen = True
            if first_busy is None:
                first_busy = now - t0
            idle_since = None
            idle_samples = 0
        else:
            if idle_since is None:
                idle_since = now
            idle_samples += 1
            ready = busy_seen or (now - t0) >= START_GRACE_S
            if ready and idle_samples >= IDLE_MIN_SAMPLES and now - idle_since >= IDLE_SECONDS:
                break
        time.sleep(max(0.0, POLL_S - (time.monotonic() - now)))
    end_busy = idle_since if (idle_since is not None and not rec["timeout"]) else time.monotonic()
    rec["wall_s"] = round(end_busy - t0, 2)
    rec["first_busy_s"] = round(first_busy, 2) if first_busy is not None else None
    rec["never_busy"] = not busy_seen
    rec["ended_at_ms"] = int(time.time() * 1000)
    final, tail, found, read_info = read_turn(drv, prompt, before_bot, shot)
    texts = final.texts()
    rec.update(read_info)
    rec["user_bubble_found"] = found
    rec["reply"] = render_lines(tail)
    rec["reply_items"] = tail
    rec["screenshot"] = os.path.relpath(shot, HERE) if shot else None
    # a failure row or an unsent row is text under the transcript; keep every static line for the judge
    rec["transcript_full"] = render_lines([{**t, "text": ("USER: " if (not t["bot"] and normalise(t["text"]) == normalise(prompt)) else "") + t["text"]}
                                           for t in sorted((t for t in texts if t["text"] not in UI_STRINGS and not t["text"].startswith("Message ")),
                                           key=lambda t: (t["y"], t["x"]))])
    return rec


# --------------------------------------------------------------------------- checks

NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
             "twelve", "thirteen", "fourteen", "fifteen", "sixteen"]


def md_files(root):
    out = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn.endswith(".md"):
                p = os.path.join(dp, fn)
                out.append((os.path.getsize(p), os.path.relpath(p, root)))
    return sorted(out, reverse=True)


def run_check(chk, ctx):
    """-> (passed, detail)."""
    t = chk["type"]
    turns = ctx["turns"]
    last = turns[-1]["reply"] if turns else ""
    if t == "reply_has_md_count":
        files = md_files(ctx["seed_copy_expected"])
        n = len(files)
        pat = rf"(?<![\d,.])({n}|{NUM_WORDS[n] if n < len(NUM_WORDS) else n})(?![\d,]|\.\d)"
        ok = re.search(pat, last, re.I) is not None
        return ok, f"expected {n} .md files; reply {'names' if ok else 'does not name'} that number"
    if t == "reply_has_largest_md":
        files = md_files(ctx["seed_copy_expected"])
        top = files[0][1]
        ok = os.path.basename(top).lower() in last.lower()
        return ok, f"largest is {top} ({files[0][0]} bytes); reply {'names' if ok else 'does not name'} it"
    if t == "tree_unchanged":
        after = tree_hashes(ctx["scratch"])
        allowed_new = set(chk.get("allow_new", []))
        before = ctx["tree_before"]
        changed = sorted(k for k in before if after.get(k) != before[k])
        added = sorted(k for k in after if k not in before and k not in allowed_new)
        return (not changed and not added), f"changed/removed: {changed}; added: {added}"
    if t == "file_unchanged":
        p = os.path.join(ctx["scratch"], chk["path"])
        if not os.path.exists(p):
            return False, f"{chk['path']} is gone"
        with open(p, "rb") as f:
            same = hashlib.sha256(f.read()).hexdigest() == ctx["tree_before"].get(chk["path"])
        return same, f"{chk['path']} {'unchanged' if same else 'changed'}"
    if t == "file_lines":
        p = os.path.join(ctx["scratch"], chk["path"])
        if not os.path.exists(p):
            return False, f"{chk['path']} does not exist"
        lines = [l.strip() for l in open(p).read().splitlines() if l.strip()]
        return lines == chk["lines"], f"lines: {lines}"
    if t == "reply_regex":
        i = chk.get("turn", -1)
        text = turns[i]["reply"] if turns and -len(turns) <= i < len(turns) else ""
        flags = re.I if "i" in chk.get("flags", "") else 0
        ok = re.search(chk["pattern"], text, flags) is not None
        return ok, f"/{chk['pattern']}/ on turn {i}: {'match' if ok else 'no match'}"
    if t == "cards_at_least":
        n = len(ctx["cards"])
        return n >= chk["n"], f"{n} approval cards seen"
    if t == "cards_at_most":
        n = len(ctx["cards"])
        return n <= chk["n"], f"{n} approval cards seen"
    if t == "activity_seen":
        flags = re.I if "i" in chk.get("flags", "") else 0
        hits = [a["label"] for a in ctx["activity"] if re.search(chk["pattern"], a["label"], flags)]
        return bool(hits), f"labels matching: {sorted(set(hits))[:5]}"
    if t == "asks_question":
        asked = any(q for tr in turns for q in tr["questions"]) or "?" in last
        return asked, "a question card was shown" if any(tr["questions"] for tr in turns) else ("reply contains a question mark" if "?" in last else "no question asked")
    if t == "memory_note_added":
        word = chk["contains"].lower()
        before, after = ctx["mem_before"], ctx["mem_after"]
        hits = [k for k, v in after.items() if word in v["text"].lower() and (k not in before or before[k]["sha"] != v["sha"])]
        pre = [k for k, v in before.items() if word in v["text"].lower()]
        ctx["memory_new_or_changed"] = hits
        ctx["memory_preexisting_matches"] = pre
        return bool(hits), f"new or changed notes containing {word!r}: {hits}; already present before: {pre}"
    if t == "routine_created":
        new = {k: v for k, v in ctx["routines_after"].items() if k not in ctx["routines_before"]}
        ctx["routines_created"] = sorted(new)
        for rid, r in new.items():
            for s in r.get("schedules", []):
                if s.get("kind") == "weekly" and sorted(s.get("days", [])) == chk["days"] and s.get("time") == chk["time"]:
                    return True, f"routine {rid} {r.get('name')!r} runs weekly on days {chk['days']} at {chk['time']}"
        return False, f"new routines: {[(k, v.get('schedules')) for k, v in new.items()]}"
    if t == "html_final":
        p = os.path.join(ctx["scratch"], "index.html")
        if not os.path.exists(p):
            return False, "index.html does not exist"
        html = open(p).read()
        low = html.lower()
        problems = []
        if chk["old_title"].lower() in low:
            problems.append(f"still contains {chk['old_title']!r}")
        title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        if title and chk["title"].lower() not in title.group(1).lower():
            problems.append(f"<title> is {title.group(1).strip()!r}")
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.I | re.S)
        if not h1 or chk["title"].lower() not in h1.group(1).lower():
            problems.append("h1 does not read the new title")
        for it in chk["items"]:
            if not re.search(r"<li[^>]*>[^<]*" + re.escape(it), html, re.I):
                problems.append(f"no <li> with {it}")
        if chk["color"].lower() not in low:
            problems.append(f"colour {chk['color']} not in the file")
        return not problems, "; ".join(problems) or "title, h1, four items and colour all present"
    raise RuntimeError(f"unknown check type {t!r}")


# --------------------------------------------------------------------------- run

def load_tasks(only):
    spec = json.load(open(os.path.join(HERE, "tasks.json")))
    tasks = spec["tasks"]
    if only:
        want = [w.strip() for w in only.split(",") if w.strip()]
        keep = []
        for w in want:
            w2 = f"t{int(w):02d}" if w.isdigit() else w
            m = [t for t in tasks if t["id"] == w or t["id"].startswith(w2 + "-") or t["id"] == w2]
            if not m:
                raise Refuse(f"--only: no task matches {w!r}")
            keep.append(m[0])
        tasks = keep
    return tasks


def git_head():
    p = subprocess.run(["git", "-C", HERE, "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return p.stdout.strip() or None


def app_info():
    import plistlib
    p = os.path.join(HOME, "Applications", "Useful Bot Dev.app", "Contents", "Info.plist")
    try:
        with open(p, "rb") as f:
            d = plistlib.load(f)
        return {"bundle_id": d.get("CFBundleIdentifier"), "version": d.get("CFBundleShortVersionString"),
                "build": d.get("CFBundleVersion"),
                "bundle_mtime": dt.datetime.fromtimestamp(os.stat(p).st_mtime).isoformat(timespec="seconds")}
    except Exception as e:
        return {"error": str(e)}


def write_judge_input(path, rec):
    lines = [f"# Task {rec['task_id']}: {rec['title']}", "",
             "## Rubric", rec["rubric"], "",
             "## What the harness did with approval cards",
             f"policy: {rec['approvals']['policy']} (expected: {rec['approvals']['expect']})", ""]
    if rec["cards"]:
        for c in rec["cards"]:
            lines.append(f"- card at {c['t']}s: tool `{c['tool']}`, preview: {c['preview']!r} -> {c['decision']}")
    else:
        lines.append("- no approval card appeared")
    lines += ["", "## Activity labels seen while the bot worked (time in s, label)"]
    lines += [f"- {a['t']}: {a['label']}" for a in rec["activity"]] or ["- none"]
    lines += ["", "## Deterministic checks (gating ones decide the pass; the others are evidence)"]
    for c in rec["checks"]:
        lines.append(f"- [{'PASS' if c['pass'] else 'FAIL'}] {'gating' if c['gating'] else 'info'} {c['type']}: {c['detail']}")
    lines += ["", "## Turns"]
    for tr in rec["turns"]:
        lines += [f"### Turn {tr['turn'] + 1}", f"Owner: {tr['prompt']}", "",
                  f"Timeout: {tr['timeout']}  Wall: {tr['wall_s']}s", "", "Bot (as shown in the transcript):", tr["reply"] or "(nothing)"]
        for q in tr["questions"]:
            lines.append(f"[question card] {q['heading']} {q['texts']} options={q['options']}")
        lines.append("")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", choices=["eve", "pi"], required=True, help="a label only")
    ap.add_argument("--run-id", help="default <date>-<engine>, or <date>-<engine>-dry-run")
    ap.add_argument("--only", help="task ids or numbers, comma separated (t03 or 3)")
    ap.add_argument("--dry-run", action="store_true", help="walk the UI without sending anything")
    ap.add_argument("--scratch", default=DEFAULT_SCRATCH,
                    help=f"scratch root, must be under your home (default {DEFAULT_SCRATCH}); the bot works under home")
    args = ap.parse_args()
    today = dt.date.today().isoformat()
    run_id = args.run_id or f"{today}-{args.engine}" + ("-dry-run" if args.dry_run else "")
    run_dir = os.path.join(HERE, "runs", run_id)
    seed = os.path.join(HERE, "fixtures", "seed")
    scratch_root = os.path.realpath(args.scratch)
    drv = Driver(f"golden-{run_id}-{int(time.time())}")  # an ended session label cannot be reused
    try:
        tasks = load_tasks(args.only)
        # One made-up fact per run, so the memory tasks can't pass on notes
        # an earlier run (or the owner) left behind. Seeded by the run id, so a
        # rerun of the same id asks the same thing.
        words = ["amber", "cobalt", "juniper", "saffron", "quartz", "tamarind", "obsidian", "marigold"]
        codeword = words[int(hashlib.sha256(run_id.encode()).hexdigest(), 16) % len(words)] + "-" + hashlib.sha256(run_id.encode()).hexdigest()[:4]
        tasks = json.loads(json.dumps(tasks).replace("{codeword}", codeword))
        if not scratch_root.startswith(HOME + os.sep):
            raise Refuse(f"scratch {scratch_root} is outside {HOME}: the bot's file tools stop at the owner's home "
                         "(agent/lib/workspace.ts path_escape), so every file task would fail")
        if os.path.exists(os.path.join(run_dir, "run.json")) and not args.dry_run:
            raise Refuse(f"{run_dir} already has a run; pick a new --run-id (results are never overwritten)")
        if screen_locked():
            raise Refuse("the screen is locked: capture and clicks are blocked. Unlock it and rerun.")
        if not os.path.exists(CUA):
            raise Refuse(f"{CUA} not found")
        win = drv.find_window()
        cmd = check_app_identity(drv.pid)
        log(f"target: Useful Bot Dev pid {drv.pid} window {drv.window_id} ({'dry run' if args.dry_run else 'LIVE'})")
        os.makedirs(os.path.join(run_dir, "shots"), exist_ok=True)

        pre = {"engine": args.engine, "run_id": run_id, "dry_run": args.dry_run, "started_at": dt.datetime.now().isoformat(timespec="seconds"),
               "harness_commit": git_head(), "python": platform.python_version(), "cua_driver": subprocess.run([CUA, "--version"], capture_output=True, text=True).stdout.strip(),
               "app": app_info(), "app_command": cmd, "window": win, "scratch_root": scratch_root, "tasks": [t["id"] for t in tasks]}
        snap0 = drv.snapshot()
        for needed in ("Search", "New chat", "Effort, speed, and model", "What the bot may do on this Mac"):
            if snap0.find(label=needed, role="AXButton") is None:
                raise Refuse(f"selector missing: no button labelled {needed!r}. Is a chat window open (not first-run or Settings)?")
        # Somebody else using the app (a turn running, a draft in the composer) is not a quiet app.
        for _ in range(6):
            s = drv.snapshot()
            comp = s.find(role="AXTextArea")
            if s.find(label="Stop", role="AXButton") or s.working_label() or s.approval_cards() or (comp and comp.get("value")):
                time.sleep(2)
                continue
            break
        else:
            raise Refuse("Useful Bot Dev is in use (a turn is running, a card is open or the composer holds text). "
                         "The harness needs the app to itself; try again when it is quiet.")
        pre["model"] = ensure_model_effort(drv, args.dry_run)
        pre["bot_state"] = bot_state()
        log("model:", pre["model"])
        if args.dry_run:
            pre["selectors"] = {k: bool(snap0.find(label=k, role="AXButton")) for k in
                                ("Search", "New chat", "Routines", "Library", "Connectors", "Attach files or a folder",
                                 "Working folder for this conversation", "What the bot may do on this Mac",
                                 "Effort, speed, and model", "Account")}
            pre["selectors"]["composer text area"] = snap0.find(role="AXTextArea") is not None

        results = []
        for task in tasks:
            tid = task["id"]
            log(f"== {tid} {task['title']}")
            scratch = os.path.join(scratch_root, run_id, tid)
            rec = {"task_id": tid, "title": task["title"], "engine": args.engine, "run_id": run_id,
                   "permission_required": task["permission"], "approvals": task["approvals"], "rubric": task["rubric"],
                   "scratch_dir": scratch, "errors": []}
            prompts = [p.replace("{dir}", scratch) for p in task["prompts"]]
            rec["prompts"] = prompts
            perm = ensure_permission(drv, task["permission"], args.dry_run)
            rec["permission_state"] = perm
            snap = new_chat(drv)
            rec["new_chat_empty"] = True
            if args.dry_run:
                typed = type_prompt(drv, prompts[0])
                cleared = clear_composer(drv)
                send_el = drv.snapshot().find(label="Send", role="AXButton")
                rec["dry_run"] = {"typed": typed, "cleared": cleared, "send_button_after_clear_enabled": bool(send_el and send_el.get("enabled", True)),
                                  "prompt_chars": len(prompts[0]), "scratch_would_be": scratch}
                log(f"  dry: typed={typed} cleared={cleared}")
                results.append(rec)
                continue
            if os.path.exists(scratch):
                raise Refuse(f"{scratch} exists; scratch folders are never reused")
            shutil.copytree(seed, scratch)
            ctx = {"scratch": scratch, "tree_before": tree_hashes(scratch), "mem_before": memory_snapshot(),
                   "routines_before": routines_snapshot(), "cards": [], "activity": [], "turns": [],
                   "seed_copy_expected": seed}
            start_ms = int(time.time() * 1000)
            turns = []
            for i, prompt in enumerate(prompts):
                shot = os.path.join(run_dir, "shots", f"{tid}-turn{i + 1}.png")
                log(f"  turn {i + 1}/{len(prompts)}: {prompt[:80]!r}")
                tr = run_turn(drv, prompt, task["approvals"]["policy"], shot, i)
                # The bot may work anywhere under home: flag any approved card that doesn't name
                # this task's scratch folder, so the judge and the write-up can see it.
                for c in tr["cards"]:
                    c["names_scratch"] = scratch in (c.get("preview") or "")
                turns.append(tr)
                ctx["turns"] = turns
                ctx["cards"] += tr["cards"]
                ctx["activity"] += tr["activity"]
                log(f"    wall {tr['wall_s']}s, first work {tr['first_busy_s']}s after Send, cards {len(tr['cards'])}"
                    f"{', TIMEOUT' if tr['timeout'] else ''}{', never busy' if tr['never_busy'] else ''}")
                if tr["timeout"]:
                    rec["errors"].append(f"turn {i + 1} hit the {int(TURN_LIMIT_S)}s limit; later turns skipped")
                    break
            end_ms = int(time.time() * 1000)
            ctx["mem_after"] = memory_snapshot()
            ctx["routines_after"] = routines_snapshot()
            checks = []
            for chk in task["checks"]:
                try:
                    ok, detail = run_check(chk, ctx)
                except Exception as e:
                    ok, detail = False, f"check crashed: {e}"
                checks.append({"type": chk["type"], "gating": chk.get("gating", True), "pass": bool(ok), "detail": detail})
            rec.update({
                "window_ms": {"start": start_ms, "end": end_ms},
                "turns": turns, "cards": ctx["cards"], "activity": ctx["activity"],
                "checks": checks,
                "checks_pass": all(c["pass"] for c in checks if c["gating"]) and not any("limit" in e for e in rec["errors"]),
                "wall_s_total": round(sum(t["wall_s"] for t in turns), 2),
                "timeouts": [t["turn"] + 1 for t in turns if t["timeout"]],
                "memory_new_or_changed": ctx.get("memory_new_or_changed", []),
                "memory_preexisting_matches": ctx.get("memory_preexisting_matches", []),
                "routines_created": sorted(k for k in ctx["routines_after"] if k not in ctx["routines_before"]),
                "bot_state_after": bot_state(),
            })
            os.makedirs(os.path.join(run_dir, "judge-input"), exist_ok=True)
            write_judge_input(os.path.join(run_dir, "judge-input", f"{tid}.md"), rec)
            with open(os.path.join(run_dir, f"{tid}.json"), "w") as f:
                json.dump(rec, f, indent=2, ensure_ascii=False)
                f.write("\n")
            log(f"  checks {'PASS' if rec['checks_pass'] else 'FAIL'}: " + "; ".join(f"{c['type']}={'ok' if c['pass'] else 'FAIL'}" for c in checks))
            results.append(rec)

        if args.dry_run:
            pre["dry_run_tasks"] = results
        else:
            pre["created_routines"] = sorted({r for rec in results for r in rec["routines_created"]})
            pre["summary"] = {r["task_id"]: {"checks_pass": r["checks_pass"], "wall_s_total": r["wall_s_total"], "timeouts": r["timeouts"]} for r in results}
        pre["finished_at"] = dt.datetime.now().isoformat(timespec="seconds")
        with open(os.path.join(run_dir, "dry-run.json" if args.dry_run else "run.json"), "w") as f:
            json.dump(pre, f, indent=2, ensure_ascii=False)
            f.write("\n")
        if pre.get("created_routines"):
            log("routines created (the harness never deletes; remove after the run):", ", ".join(pre["created_routines"]))
        log(f"done: {run_dir}")
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    finally:
        drv.end()


if __name__ == "__main__":
    sys.exit(main())
