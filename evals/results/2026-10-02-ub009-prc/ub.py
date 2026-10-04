#!/usr/bin/env python3
"""Drive Useful Bot Dev in the background through ONE `cua-driver mcp` session.

Usage: ub.py '<json list of steps>'
Steps:
  {"op":"tools"}                                  list tool names
  {"op":"shot","out":"file.png"}                  screenshot + print matching elements
  {"op":"find","q":"text"}                         print elements whose text contains q
  {"op":"click","q":"text"}                        click the first element matching q (identifier or label)
  {"op":"type","q":"text","text":"..."}            type into the element matching q
  {"op":"key","key":"escape"}                      press a key
  {"op":"wait","s":1.0}
  {"op":"scroll","x":..,"y":..,"dy":..}
Elements print as: index | role | identifier | label/title/value (truncated).
"""
import base64, json, subprocess, sys, time, os

APP = "UsefulBotDevApp"
proc = subprocess.Popen([os.path.expanduser("~/.local/bin/cua-driver"), "mcp"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, bufsize=1, cwd=os.path.expanduser("~"))
_id = 0

def rpc(method, params=None, notify=False):
    global _id
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if not notify:
        _id += 1
        msg["id"] = _id
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    if notify:
        return None
    while True:
        line = proc.stdout.readline()
        if not line:
            raise SystemExit("cua-driver closed")
        r = json.loads(line)
        if r.get("id") == _id:
            if "error" in r:
                raise SystemExit(f"error: {r['error']}")
            return r["result"]

def call(name, args):
    res = rpc("tools/call", {"name": name, "arguments": args})
    out = {}
    for c in res.get("content", []):
        if c.get("type") == "text":
            try:
                out.update(json.loads(c["text"]))
            except Exception:
                out.setdefault("_text", []).append(c["text"])
        elif c.get("type") == "image":
            out["_image"] = c.get("data")
    if res.get("structuredContent"):
        out.update(res["structuredContent"])
    if res.get("isError"):
        raise SystemExit(f"{name} failed: {json.dumps(out)[:600]}")
    return out

rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "ub", "version": "1"}})
rpc("notifications/initialized", notify=True)

def target():
    wins = call("list_windows", {})
    ws = wins.get("windows", [])
    mine = [w for w in ws if APP in json.dumps(w) or "Useful Bot Dev" in json.dumps(w)]
    if not mine:
        raise SystemExit("no Useful Bot Dev window: " + json.dumps(ws)[:400])
    def area(w):
        b = w.get("bounds") or w.get("frame") or {}
        return (b.get("width", 0) or 0) * (b.get("height", 0) or 0)
    w = max(mine, key=area)
    return {"pid": w.get("pid") or w.get("owner_pid"), "window_id": w.get("window_id") or w.get("id")}

T = None
STATE = None

def state():
    global STATE
    for attempt in range(8):
        STATE = call("get_window_state", {**T, "max_elements": 30000})
        if STATE.get("elements"):
            return STATE
        time.sleep(3)
    return STATE

def text_of(e):
    parts = [str(e.get(k)) for k in ("role", "identifier", "label", "title", "value", "description") if e.get(k)]
    return " | ".join(parts)

def match(q):
    els = STATE.get("elements", [])
    exact = [e for e in els if q in (e.get("identifier"), e.get("label"), e.get("title"), e.get("role"))]
    if exact:
        exact.sort(key=lambda e: 0 if e.get("role") == "AXButton" else 1)
        return exact[0]
    loose = [e for e in els if q.lower() in text_of(e).lower()]
    return loose[0] if loose else None

steps = json.loads(sys.argv[1])
T = target()
print("target", T)
for s in steps:
    op = s["op"]
    if op == "tools":
        print([t["name"] for t in rpc("tools/list")["tools"]])
    elif op == "shot":
        st = state()
        img = st.get("screenshot_png_b64") or st.get("_image")
        if img and s.get("out"):
            open(s["out"], "wb").write(base64.b64decode(img))
            print("saved", s["out"])
        print("elements", len(st.get("elements", [])))
    elif op == "find":
        state()
        for i, e in enumerate(STATE.get("elements", [])):
            t = text_of(e)
            if s["q"].lower() in t.lower():
                print(i, e.get("role"), "|", t[:120], e.get("screenshot_frame"))
    elif op == "click":
        state()
        e = match(s["q"]) if "i" not in s else STATE["elements"][s["i"]]
        if not e:
            raise SystemExit(f"no element for {s['q']}")
        print("click", e.get("role"), text_of(e)[:100])
        args = {**T, "element_token": e["element_token"]}
        if s.get("button"): args["button"] = s["button"]
        call("click", args)
    elif op == "clickxy":
        st = state()
        args = {**T, "x": s["x"], "y": s["y"]}
        if st.get("capture_id"): args["capture_id"] = st["capture_id"]
        call("click", args)
        print("clicked", s["x"], s["y"])
    elif op == "type":
        state()
        e = match(s["q"]) if "i" not in s else STATE["elements"][s["i"]]
        if not e:
            raise SystemExit(f"no element for {s['q']}")
        call("type_text", {**T, "element_token": e["element_token"], "text": s["text"]})
    elif op == "key":
        call("press_key", {**T, "key": s["key"]})
    elif op == "hotkey":
        call("hotkey", {**T, "keys": s["keys"]})
    elif op == "scroll":
        call("scroll", {**T, "x": s["x"], "y": s["y"], "delta_y": s["dy"]})
    elif op == "wait":
        time.sleep(s["s"])
proc.stdin.close()
proc.terminate()
