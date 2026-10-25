#!/usr/bin/env python3
"""End-to-end check of the Pi engine in Useful Bot Dev (SPEC 14 "E2E").

Drives the dev app's UI in the background through cua-driver (accessibility tokens, no real
pointer, focus or keyboard), and checks what the engine wrote: session files, the chat index,
memory notes, files on disk. Writes a JSON report with every step's outcome and timing, and a
screenshot per step, into verify/<branch>/e2e/<run-id>/ of the main checkout.

Useful Bot Dev must be running and idle on a chat window. Never the daily app.

  python3 scripts/dev/e2e-pi.py --run-id 2026-10-25-a                  # every step
  python3 scripts/dev/e2e-pi.py --run-id 2026-10-25-a --only queue,cancel
"""
import argparse, json, os, re, signal, subprocess, sys, time

HOME = os.path.expanduser("~")
CUA = f"{HOME}/.local/bin/cua-driver"
APP = "Useful Bot Dev"
STATE = f"{HOME}/.useful-bot-dev-app"
ENGINE = f"{STATE}/engine"
DEV_RUNTIME = f"{HOME}/Library/Application Support/Useful Bot Dev/app"
# The main checkout (verify/ lives there, not in a worktree).
MAIN = os.path.dirname(os.path.abspath(subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()))
TURN_LIMIT_S = 300


class Fail(Exception):
    pass


# ------------------------------------------------------------------ driver

class Driver:
    def __init__(self, session, shots):
        self.session = session
        self.shots = shots
        self.pid = self.wid = None
        self.n = 0

    def call(self, tool, args, timeout=90):
        p = subprocess.run([CUA, "call", tool, json.dumps(args)], capture_output=True, text=True, cwd=HOME, timeout=timeout)
        try:
            return json.loads(p.stdout)
        except json.JSONDecodeError:
            raise Fail(f"cua-driver {tool}: {p.stdout[:200]!r} {p.stderr[:200]!r}")

    def window(self):
        ws = [w for w in self.call("list_windows", {}).get("windows", [])
              if w.get("app_name") == APP and w.get("title") == APP and w.get("is_on_screen")]
        if not ws:
            raise Fail("no Useful Bot Dev window on screen")
        w = max(ws, key=lambda w: w["bounds"]["width"] * w["bounds"]["height"])
        self.pid, self.wid = w["pid"], w["window_id"]

    def els(self):
        for _ in range(5):
            d = self.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "session": self.session,
                                               "max_elements": 30000, "include_screenshot": False,
                                               "timeout_ms": 8000, "tree_format": "both"})
            if len(d.get("elements") or []) >= 5:
                self.md = d.get("tree_markdown") or ""
                return d["elements"]
            time.sleep(1)
        raise Fail("empty accessibility walk")

    @staticmethod
    def text(e):
        return " | ".join(str(e.get(k)) for k in ("role", "label", "value", "identifier", "description") if e.get(k))

    def find(self, pred, nth=0):
        hits = [e for e in self.els() if e.get("element_token") and pred(e)]
        return hits[nth] if len(hits) > nth else None

    def button(self, label, nth=0, wait=0.0):
        end = time.time() + wait
        while True:
            e = self.find(lambda e: e.get("role") == "AXButton" and e.get("label") == label, nth)
            if e or time.time() >= end:
                return e
            time.sleep(0.5)

    def click(self, e):
        r = self.call("click", {"pid": self.pid, "window_id": self.wid, "session": self.session, "element_token": e["element_token"]})
        if r.get("refusal"):
            raise Fail(f"click refused: {r['refusal']}")
        return r

    def click_label(self, label, nth=0, wait=10.0):
        e = self.button(label, nth, wait)
        if not e:
            raise Fail(f"no button {label!r}")
        return self.click(e)

    def field(self, role):
        """The composer by its id, else the lowest text area: a reply block with a link is a text area too.
        cua-driver lists an unlabelled element's id as its label, and can drop it for a moment after a set_value."""
        fields = [e for e in self.els() if e.get("role") == role and e.get("element_token")]
        if role != "AXTextArea" or not fields:
            return fields[0] if fields else None
        named = [e for e in fields if "composer-input" in (e.get("identifier"), e.get("label"))]
        if named:
            return named[0]
        if len(fields) == 1:
            return fields[0]
        if not all((e.get("frame") or {}).get("y") is not None for e in fields):
            raise Fail("text areas without frames: can't tell the composer")
        return max(fields, key=lambda e: e["frame"]["y"])

    def type(self, text, role="AXTextArea"):
        """Replace the field's text: clear it, then type (the composer keeps a draft between steps)."""
        e = self.field(role)
        if not e:
            raise Fail(f"no {role}")
        self.call("set_value", {"pid": self.pid, "element_token": e["element_token"], "value": ""})
        e = self.field(role)
        r = self.call("type_text", {"pid": self.pid, "window_id": self.wid, "session": self.session,
                                    "element_token": e["element_token"], "text": text})
        if r.get("effect") != "confirmed":
            raise Fail(f"type_text: {str(r)[:200]}")

    def send(self, text):
        """Send, or queue when a turn is running (then the button is Stop and Return sends)."""
        self.type(text)
        if self.button("Send"):
            self.click_label("Send")
            return
        r = self.call("press_key", {"pid": self.pid, "window_id": self.wid, "session": self.session, "key": "return"})
        if r.get("refusal"):
            raise Fail(f"return refused: {r['refusal']}")

    def shot(self, name):
        self.n += 1
        path = f"{self.shots}/{self.n:02d}-{name}.png"
        self.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "include_accessibility_tree": False,
                                       "screenshot_out_file": path, "max_image_dimension": 1400})
        return path

    def busy(self):
        return any(e.get("role") == "AXButton" and e.get("label") in ("Stop", "Approve") for e in self.els())

    def wait_idle(self, limit=TURN_LIMIT_S, on_card=None):
        """Idle = 3 quiet samples a second apart (no Stop button, no card)."""
        start, quiet = time.time(), 0
        while time.time() - start < limit:
            els = self.els()
            if on_card and any(e.get("label") == "Approve" for e in els):
                on_card()
                quiet = 0
            elif any(e.get("role") == "AXButton" and e.get("label") in ("Stop", "Approve") for e in els):
                quiet = 0
            else:
                quiet += 1
                if quiet >= 3:
                    return round(time.time() - start - 2, 1)
            time.sleep(1)
        raise Fail(f"turn still running after {limit}s")

    def transcript(self):
        self.els()
        return self.md


def answer_card(d, ctx, seen=None):
    """Approve a card only when it acts inside this run's work folder; deny anything else.
    A web page the bot read could ask for another command: the run never approves that."""
    # Only the card's own text: the window also holds the owner's prompt, which names the folder.
    md = d.md or ""
    start = md.rfind("Needs approval")
    end = md.find("Approve", start)
    card = md[start:end] if start >= 0 and end > start else ""
    expected = bool(card) and (ctx["work"] in card or "UsefulBotE2E" in card)
    if seen is not None:
        seen.append(d.shot("card"))
    d.click_label("Approve" if expected else "Deny")
    ctx.setdefault("cards", []).append({"approved": expected})


# ------------------------------------------------------------------ engine state (read-only)

def chats():
    return json.load(open(f"{ENGINE}/chats.json"))["chats"]


def entries(chat):
    if not chat.get("sessionFile"):
        return []
    path = chat["sessionFile"] if chat["sessionFile"].startswith("/") else f"{ENGINE}/{chat['sessionFile']}"
    return [json.loads(l) for l in open(path)]


def chat_by_title(prefix):
    hits = [c for c in chats() if c["title"].startswith(prefix) and not c.get("fixture")]
    if not hits:
        raise Fail(f"no chat titled {prefix!r}")
    return max(hits, key=lambda c: c["updatedAt"])


def turn_ends(chat):
    return [e["data"] for e in entries(chat) if e.get("type") == "custom" and e.get("customType") == "ub.turn-end"]


def custom(chat, kind):
    return [e.get("data") for e in entries(chat) if e.get("customType") == kind]


def tool_names(chat):
    names = []
    for e in entries(chat):
        m = e.get("message") or {}
        if m.get("role") == "assistant":
            for part in m.get("content") or []:
                if part.get("type") == "toolCall":
                    names.append(part.get("name"))
    return names


def engine_pids():
    out = subprocess.run(["pgrep", "-f", f"{DEV_RUNTIME}/agent/server.ts"], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


# ------------------------------------------------------------------ steps

def new_chat(d):
    d.click_label("New chat")
    time.sleep(1)


def step_multi(d, ctx):
    """One chat, a multi-step job: bash with an approval, an HTML page, a web search and a memory note."""
    new_chat(d)
    work = ctx["work"]
    os.makedirs(work, exist_ok=True)
    code = ctx["code"]
    cards = []
    d.send(f"E2E multi {code}. Do these in order: 1) use bash to run `mkdir -p {work}/out && date > {work}/out/stamp.txt`. "
           f"2) write an HTML page to {work}/out/report.html titled 'E2E report {code}' with one paragraph. "
           f"3) search the web for 'Pi agent harness Earendil' and name one result. "
           f"4) save a memory note that the E2E codename is {code}. Then say done.")
    t = d.wait_idle(on_card=lambda: answer_card(d, ctx, cards))
    d.shot("multi-done")
    chat = chat_by_title(f"E2E multi {code}")
    tools = tool_names(chat)
    notes = subprocess.run(["grep", "-rl", code, f"{STATE}/memory"], capture_output=True, text=True).stdout.split()
    checks = {
        "stamp_file": os.path.exists(f"{work}/out/stamp.txt"),
        "page_file": os.path.exists(f"{work}/out/report.html"),
        "approval_card_seen": len(cards) >= 1,
        "used_bash": "bash" in tools, "used_write_file": "write_file" in tools,
        "used_web_search": "web_search" in tools, "used_memory": "memory" in tools,
        "page_row": any(r.get("kind") == "page" for r in custom(chat, "ub.row")),
        "memory_note_on_disk": bool(notes),
        "turn_completed": (turn_ends(chat) or [{}])[-1].get("outcome") == "completed",
    }
    ctx["multi_chat"] = chat["chatId"]
    return {"seconds": t, "tools": tools, "checks": checks}


def step_queue(d, ctx):
    """Three quick sends: three turns, in order, each its own turn."""
    new_chat(d)
    code = ctx["code"]
    d.send(f"E2E queue {code}. Write a 700 word essay about tides.")
    time.sleep(1.5)
    if not d.button("Stop", wait=20):
        raise Fail("the first turn never showed as running")
    d.send("Now say the word apple.")
    d.send("Now say the word pear.")
    md_mid = d.transcript()
    d.shot("queued")
    t = d.wait_idle(on_card=lambda: answer_card(d, ctx))
    d.shot("queue-done")
    chat = chat_by_title(f"E2E queue {code}")
    starts = [e["data"] for e in entries(chat) if e.get("customType") == "ub.turn-start"]
    texts = [s.get("text", "") for s in starts]
    ends = turn_ends(chat)
    return {"seconds": t, "turn_texts": texts, "checks": {
        "three_turns": len(starts) == 3,
        "in_order": texts[1:] == ["Now say the word apple.", "Now say the word pear."],
        "all_completed": len(ends) == 3 and all(e.get("outcome") == "completed" for e in ends),
        "queued_tag_seen": "Queued" in md_mid or "queued" in md_mid,
    }}


def step_cancel(d, ctx):
    """Cancel with an approval card pending: Stop returns at once, the card goes, queued sends drop."""
    new_chat(d)
    code = ctx["code"]
    d.send(f"E2E cancel {code}. Use bash to run `touch {ctx['work']}/cancel-me.txt`.")
    if not d.button("Approve", wait=90):
        raise Fail("no approval card appeared")
    d.send("And then say banana.")
    time.sleep(1)
    d.shot("card-pending")
    t0 = time.time()
    d.click_label("Stop")
    gone = None
    while time.time() - t0 < 5:
        walk_started = time.time()  # an AX walk takes most of a second: time the card by when the walk began
        if not d.button("Approve"):
            gone = round(walk_started - t0, 2)
            break
    d.wait_idle(limit=60)
    d.shot("cancelled")
    chat = chat_by_title(f"E2E cancel {code}")
    ends = turn_ends(chat)
    return {"card_gone_s": gone, "checks": {
        # One AX walk takes about 1.2 s, so this is the walk-resolution bound; the 1 s claim
        # is checked on a 60 fps recording (see the write-up) and by engine contract test 13.
        "card_gone_by_next_walk": gone is not None and gone <= 1.5,
        "turn_cancelled": bool(ends) and ends[0].get("outcome") == "cancelled",
        "file_not_created": not os.path.exists(f"{ctx['work']}/cancel-me.txt"),
        "queued_dropped": len(custom(chat, "ub.queued-drop")) >= 1,
        "send_again_offered": d.button("Send again") is not None,
    }}


def step_interrupt(d, ctx):
    """Kill the engine mid-turn: the chat shows Interrupted with Retry, and Retry finishes it."""
    new_chat(d)
    code = ctx["code"]
    d.send(f"E2E interrupt {code}. Write a 400 word story about a lighthouse.")
    deadline = time.time() + 60
    while time.time() < deadline and not d.button("Stop"):
        time.sleep(0.5)
    time.sleep(2)
    pids = engine_pids()
    if len(pids) != 1:
        raise Fail(f"expected one dev engine process, found {pids}")
    os.kill(pids[0], signal.SIGKILL)
    t0 = time.time()
    retry, how = None, "watchdog"
    while time.time() - t0 < 60:
        retry = d.button("Retry")
        if retry:
            break
        time.sleep(1)
    if not retry:
        # The supervisor didn't bring the engine back: relaunch the app (SPEC 14 "kill and relaunch").
        how = "relaunch"
        subprocess.run(["osascript", "-e", 'tell application id "ai.useful.bot.dev" to quit'], capture_output=True)
        time.sleep(6)
        subprocess.run(["open", "-g", f"{HOME}/Applications/Useful Bot Dev.app"])
        time.sleep(30)
        d.window()
        retry = d.button("Retry", wait=60)
    d.shot("interrupted")
    if not retry:
        raise Fail("no Retry after the engine was killed and the app relaunched")
    back = round(time.time() - t0, 1)
    d.click_label("Retry")
    t = d.wait_idle(on_card=lambda: answer_card(d, ctx))
    d.shot("retried")
    chat = chat_by_title(f"E2E interrupt {code}")
    ends = turn_ends(chat)
    outcomes = [e.get("outcome") for e in ends]
    return {"retry_offered_after_s": back, "recovered_by": how, "seconds": t, "outcomes": outcomes, "checks": {
        "interrupted_recorded": "interrupted" in outcomes,
        "retry_completed": outcomes[-1:] == ["completed"],
    }}


def step_reopen(d, ctx):
    """New chat, then reopen the multi-step chat from the sidebar: its page row and note survive."""
    new_chat(d)
    d.send(f"E2E other {ctx['code']}. Use no tools. Reply with the single word hi.")
    d.wait_idle(on_card=lambda: d.click_label("Deny"))
    target = f"E2E multi {ctx['code']}"[:20]
    row = d.find(lambda e: e.get("role") in ("AXButton", "AXCell", "AXRow", "AXStaticText") and target in Driver.text(e))
    if not row:
        raise Fail("multi chat not in the sidebar")
    d.click(row)
    time.sleep(3)
    md = d.transcript()
    d.shot("reopened")
    return {"checks": {
        "page_row_visible": "report.html" in md or "E2E report" in md,
        "owner_message_visible": f"E2E multi {ctx['code']}" in md,
    }}


def step_search(d, ctx):
    """Search finds the multi chat by message text."""
    d.click_label("Search")
    time.sleep(1)
    d.type("stamp.txt", role="AXTextField")
    time.sleep(3)
    md = d.transcript()
    d.shot("search")
    # A message-text hit carries a snippet with the word; no chat title or sidebar row contains it.
    found = md.count("stamp.txt") >= 2  # the field's own value, plus at least one hit
    d.call("press_key", {"pid": d.pid, "window_id": d.wid, "session": d.session, "key": "escape"})
    return {"checks": {"message_hit": found}}


def routines():
    return json.load(open(f"{STATE}/routines.json"))["routines"]


def step_routine(d, ctx):
    """The bot creates a routine; Test run on the Routines page runs it in its own chat."""
    new_chat(d)
    name = f"E2E ping {ctx['code']}"
    d.send(f"Create a routine named '{name}' that runs daily at 03:00 and whose instruction is: reply with the single word pong.")
    d.wait_idle(on_card=lambda: answer_card(d, ctx))
    hits = [r for r in routines() if r["name"] == name]
    if not hits:
        raise Fail("the bot did not create the routine")
    rid = hits[0]["id"]
    # Back to a normal chat so the routine runs in a chat that isn't open.
    d.click_label("Routines")
    time.sleep(2)
    # The routine's row reads "NAME, Every day at 03:00, ..."; a chat row only contains the name.
    row = d.find(lambda e: e.get("role") == "AXButton" and (e.get("label") or "").startswith(name + ","))
    if not row:
        raise Fail("routine not on the Routines page")
    d.click(row)
    time.sleep(1)
    d.shot("routine-page")
    d.click_label("Test run")
    t0 = time.time()
    marks = []
    chat = None
    while time.time() - t0 < 180:
        r = [x for x in routines() if x["id"] == rid][0]
        runs = r.get("runHistory") or []
        if r.get("chatId"):
            chat = next((c for c in chats() if c["chatId"] == r["chatId"]), None)
        if chat and runs:
            break
        time.sleep(2)
    d.shot("routine-ran")
    if not chat:
        raise Fail("no routine chat appeared")
    notes = [x for x in custom(chat, "ub.row") if x.get("kind") == "note"]
    ends = turn_ends(chat)
    r = [x for x in routines() if x["id"] == rid][0]
    runs = r.get("runHistory") or []
    return {"seconds": round(time.time() - t0, 1), "checks": {
        "own_chat_with_routine_id": chat.get("routineId") == rid,
        "chat_titled_after_routine": chat["title"] == name,
        "ran_note_row": any("ran" in (n.get("text") or "") for n in notes),
        "turn_completed": bool(ends) and ends[-1].get("outcome") == "completed",
        "run_recorded_with_chat": bool(runs) and runs[-1].get("chatId") == chat["chatId"],
    }}


def step_delete(d, ctx):
    """Delete the open chat from the menu (the confirm dialog), and the engine makes another current."""
    new_chat(d)
    d.send(f"E2E delete {ctx['code']}. Use no tools. Reply with the single word ok.")
    d.wait_idle(on_card=lambda: d.click_label("Deny"))
    chat = chat_by_title(f"E2E delete {ctx['code']}")
    # Background only: never let the driver raise or activate the app (a foreground menu run did once).
    # cmd-delete posted to the window: no raise, no activation (invoke_menu once ran in the foreground).
    r = d.call("hotkey", {"pid": d.pid, "window_id": d.wid, "session": d.session, "keys": ["cmd", "delete"]})
    if r.get("refusal") or (r.get("delivery") or {}).get("mode", "background") != "background":
        raise Fail(f"shortcut not delivered in the background: {str(r)[:200]}")
    time.sleep(1)
    d.shot("delete-confirm")
    try:
        d.click_label("Delete")
    except Fail as f:
        # The dialog closes while the press is still being reported, which comes back as -25205.
        if "-25205" not in str(f):
            raise
    time.sleep(2)
    d.shot("deleted")
    gone = not any(c["chatId"] == chat["chatId"] for c in chats())
    trashed = any(chat["chatId"] in f for f in os.listdir(f"{ENGINE}/trash")) if os.path.isdir(f"{ENGINE}/trash") else False
    return {"menu": str(r)[:120], "checks": {"removed_from_index": gone, "file_in_trash": trashed,
                                               "row_gone": not d.find(lambda e: f"E2E delete {ctx['code']}" in Driver.text(e))}}


def step_widget(d, ctx):
    """Excalidraw through find_tools: a live widget, then a widget row the app persisted."""
    new_chat(d)
    d.send(f"E2E widget {ctx['code']}. Draw a small flowchart in Excalidraw: Start, then Work, then Done.")
    t = d.wait_idle(on_card=lambda: answer_card(d, ctx))
    time.sleep(3)
    d.shot("widget")
    chat = chat_by_title(f"E2E widget {ctx['code']}")
    tools = tool_names(chat)
    rows = [r for r in custom(chat, "ub.row") if r.get("kind") == "widget"]
    return {"seconds": t, "tools": tools, "checks": {
        "used_find_tools": "find_tools" in tools,
        "called_excalidraw": any(n.startswith("excalidraw__") for n in tools if n),
        "widget_row_persisted": bool(rows),
    }}


STEPS = {"multi": step_multi, "queue": step_queue, "cancel": step_cancel, "interrupt": step_interrupt,
         "reopen": step_reopen, "search": step_search, "routine": step_routine, "delete": step_delete,
         "widget": step_widget}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--only", default=",".join(STEPS))
    a = ap.parse_args()
    branch = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True).stdout.strip() or "detached"
    out = f"{MAIN}/verify/{branch}/e2e/{a.run_id}"
    os.makedirs(out, exist_ok=True)
    code = "E" + re.sub(r"[^0-9A-Za-z]", "", a.run_id)[-8:]
    ctx = {"code": code, "work": f"{HOME}/UsefulBotE2E/{a.run_id}"}
    d = Driver(f"e2e-{a.run_id}", out)
    d.window()
    if d.busy():
        raise SystemExit("the dev app is busy; let it finish first")
    report = {"run_id": a.run_id, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": {}}
    for name in a.only.split(","):
        t0 = time.time()
        try:
            res = STEPS[name](d, ctx)
            res["ok"] = all(res.get("checks", {}).values())
        except Fail as f:
            res = {"ok": False, "error": str(f)}
            try:
                d.shot(f"{name}-error")
            except Fail:
                pass
        res["wall_s"] = round(time.time() - t0, 1)
        report["steps"][name] = res
        print(name, "ok" if res["ok"] else "FAIL", json.dumps(res)[:400], flush=True)
        json.dump(report, open(f"{out}/report.json", "w"), indent=2)
    d.call("end_session", {"session": d.session})
    print(out)
    sys.exit(0 if all(s["ok"] for s in report["steps"].values()) else 1)


main()
