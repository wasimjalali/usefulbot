#!/usr/bin/env python3
"""Performance regression guard for a native Mac app. Standard library only.

    perfguard.py check     [--app PATH] [--quick]   measure every case, compare to budgets.json
    perfguard.py baseline  [--app PATH]             measure, then propose budgets from the numbers
    perfguard.py fixtures  [--app PATH]             build the frozen fixture chats, then lock them
    perfguard.py lock      [--app PATH]             re-read the fixtures and write fixtures.lock.json

The app does the driving: launched with `-UsefulBotPerfRun <scenario.json>`
it runs the scenario's steps and writes timed marks (CLOCK_UPTIME_RAW ns).
`perfrec` records the window at 60 fps and scores how much the chat column
changed on each frame, on the same clock. This script launches, records,
lines the two up and judges. See perf/README.md for the method and its limits.
"""
import argparse
import datetime
import hashlib
import json
import os
import plistlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid

PERF = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(PERF)


def now_ns():
    return time.clock_gettime_ns(time.CLOCK_UPTIME_RAW)


def load_json(path, default=None):
    if not os.path.exists(path):
        if default is not None:
            return default
        sys.exit(f"missing {os.path.relpath(path, ROOT)}")
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


CONFIG = load_json(os.path.join(PERF, "config.json"))


# ---------------------------------------------------------------- the app


class App:
    def __init__(self, path):
        self.path = os.path.abspath(os.path.join(ROOT, path))
        info = os.path.join(self.path, "Contents/Info.plist")
        if not os.path.exists(info):
            sys.exit(f"no app at {self.path}: build it first ({CONFIG['buildHint']})")
        with open(info, "rb") as f:
            plist = plistlib.load(f)
        self.bundle_id = plist["CFBundleIdentifier"]
        self.exe = os.path.join(self.path, "Contents/MacOS", plist["CFBundleExecutable"])
        with open(self.exe, "rb") as f:
            self.exe_sha = hashlib.sha256(f.read()).hexdigest()

    def running_pids(self):
        """Every running copy of this bundle, wherever it was launched from."""
        name = os.path.basename(self.exe)
        out = run(["pgrep", "-x", name]).stdout.split()
        return [int(p) for p in out]

    def pid_of_this_copy(self):
        out = run(["pgrep", "-f", self.exe]).stdout.split()
        return int(out[0]) if out else None

    def quit_all(self):
        for _ in range(3):
            if not self.running_pids():
                return
            run(["osascript", "-e", f'tell application id "{self.bundle_id}" to quit'])
            for _ in range(100):
                if not self.running_pids():
                    return
                time.sleep(0.1)
        sys.exit("the app would not quit")

    def launch(self, scenario_path=None):
        args = ["open", "-g", "-a", self.path]
        if scenario_path:
            args += ["--args", "-UsefulBotPerfRun", scenario_path]
        t = now_ns()
        out = run(args)
        if out.returncode != 0:
            sys.exit(f"open failed: {out.stderr.strip()}")
        return t


def shell_state():
    return load_json(os.path.expanduser(CONFIG["shellState"]))


def bots_by_name():
    return {b["name"]: b for b in shell_state()["bots"]}


def owner_selection():
    """The owner's last real chat, to put back after a run.

    The open chat at the start of a run is not enough: a run that stopped
    early leaves a fixture open, and every later run then "restored" the
    fixture. The last non-fixture selection is remembered across runs.
    """
    path = os.path.join(PERF, ".runs", "owner-selection.json")
    state = shell_state()
    names = {b["id"]: b["name"] for b in state["bots"]}
    current = state.get("selectedBotId")
    fixtures = set(CONFIG["fixtures"].values())
    if current in names and names[current] not in fixtures and not names[current].startswith("Perf "):
        write_json(path, {"botId": current, "name": names[current]})
        return current
    saved = load_json(path, default={}).get("botId")
    if saved in names:
        return saved
    if current is None:
        return None
    sys.exit("the open chat is a Perf fixture and no earlier selection is known: open one of your own chats first")


# ---------------------------------------------------------------- preflight


def load_1m():
    return float(run(["sysctl", "-n", "vm.loadavg"]).stdout.split()[1])


def program_name(command):
    """The program's name from a ps command line, never its arguments.

    A path with spaces ("/Applications/Useful Bot.app/Contents/MacOS/X --flag")
    splits wrong on whitespace, so the longest leading prefix that exists on
    disk is the program. Failing that, a bundle path (".app/Contents/MacOS/X")
    in the first word of the command, or before the first flag, names the
    program by its last component; a marker later in the arguments (a grep
    for it) is ignored.
    """
    marker = ".app/Contents/MacOS/"
    head = re.split(r"\s-", command, maxsplit=1)[0]
    if marker in head:
        rest = head.split(marker, 1)[1].split()
        # The program is the one path component right after the marker; a
        # directory path followed by a bare argument names nothing.
        if rest and "/" not in rest[0] and not head.split(marker, 1)[1][:1].isspace():
            return rest[0]
        return "?"
    words = command.split()
    if not words:
        return "?"
    for n in range(len(words), 0, -1):
        candidate = " ".join(words[:n])
        if os.path.isfile(candidate):
            return os.path.basename(candidate)
    return os.path.basename(words[0])


def external_cpu():
    """CPU % of everything except the app, its services and the guard itself.

    The load average counts the run's own work: a no-snapshot launch replays
    thousands of events through the local services and pushed it past the
    limit on its own. What makes a run unfair is other work, so only that counts.
    """
    own = CONFIG["ownProcesses"]
    total, top = 0.0, []
    for line in run(["ps", "-Ao", "pcpu=,command="]).stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        # A command line with a newline in it spills onto more lines; those
        # carry no CPU column and belong to the process above.
        if not re.fullmatch(r"\d+(\.\d+)?", parts[0]):
            continue
        cpu = float(parts[0])
        command = parts[1]
        if any(p in command for p in own):
            continue
        total += cpu
        # Only the program's name goes into the record: a command line can carry
        # a key or a token (one on this machine does), and records are committed.
        try:
            name = program_name(command)
        except Exception:
            name = "?"
        top.append((cpu, name))
    top.sort(reverse=True)
    return total, [f"{c:.0f}% {n}" for c, n in top[:3] if c >= 10]


def preflight(app):
    """Conditions that make numbers meaningless fail the run; the rest is recorded."""
    facts, problems = {}, []
    ioreg = run(["ioreg", "-n", "Root", "-d1", "-a"]).stdout
    locked = "<key>CGSSessionScreenIsLocked</key>\n\t\t<true/>" in ioreg or "CGSSessionScreenIsLocked</key><true/>" in ioreg.replace("\n", "").replace("\t", "")
    facts["screenLocked"] = locked
    if locked:
        problems.append("the screen is locked: windows stop rendering")
    pm = run(["pmset", "-g"]).stdout
    facts["lowPowerMode"] = any(l.split()[:1] == ["lowpowermode"] and l.split()[-1] == "1" for l in pm.splitlines())
    if facts["lowPowerMode"]:
        problems.append("Low Power Mode is on")
    batt = run(["pmset", "-g", "batt"]).stdout
    facts["power"] = "AC" if "AC Power" in batt else "battery"
    therm = run(["pmset", "-g", "therm"]).stdout
    facts["thermal"] = " ".join(therm.split())[:200]
    if "CPU_Speed_Limit" in therm:
        limit = int(therm.split("CPU_Speed_Limit")[1].split("=")[1].split()[0])
        if limit < 100:
            problems.append(f"the CPU is thermally limited to {limit}%")
    facts["memoryFree"] = next((l.split(":")[1].strip() for l in run(["memory_pressure", "-Q"]).stdout.splitlines()
                                if "free percentage" in l), "?")
    facts["loadAverage"] = run(["sysctl", "-n", "vm.loadavg"]).stdout.strip()
    cpu, top = external_cpu()
    facts["externalCpu"] = round(cpu)
    if cpu > CONFIG["maxExternalCpu"]:
        problems.append(f"the machine is busy ({cpu:.0f}% CPU in other work, limit {CONFIG['maxExternalCpu']}%: "
                        f"{'; '.join(top)}): it would be timed too")
    # The web service serves its production build only while the sources still
    # hash to what it was built from, and only a process started after that
    # build serves it. Anything else is `next dev`, which is several times slower.
    fresh = run([CONFIG["node"], "--input-type=module", "-e",
                 "import('./scripts/web-mode.mjs').then(m => console.log(m.webLaunch(process.cwd()).mode))"], cwd=ROOT).stdout.strip()
    stamp = os.path.join(ROOT, CONFIG["webBuildStamp"])
    pids = run(["pgrep", "-f", CONFIG["webServiceProcess"]]).stdout.split()
    started_after = False
    if pids and os.path.exists(stamp):
        lstart = run(["ps", "-o", "lstart=", "-p", pids[0]]).stdout.strip()
        started = datetime.datetime.strptime(lstart, "%a %b %d %H:%M:%S %Y").timestamp()
        started_after = started >= os.path.getmtime(stamp) - 1
    facts["webMode"] = "production" if fresh == "production" and started_after else f"{fresh or 'unknown'}, service {'restarted' if started_after else 'older than the build'}"
    if facts["webMode"] != "production":
        problems.append(f"the web service is not serving a fresh production build ({facts['webMode']}): {CONFIG['buildHint']}")
    facts["macOS"] = run(["sw_vers", "-productVersion"]).stdout.strip()
    facts["machine"] = run(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.strip()
    facts["gitSha"] = run(["git", "rev-parse", "HEAD"], cwd=ROOT).stdout.strip()
    facts["gitDirty"] = bool(run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT).stdout.strip())
    facts["app"] = app.path
    facts["appSha256"] = app.exe_sha
    stamp_file = os.path.join(app.path, "Contents/Resources/ub-app-sources.sha256")
    built_from = open(stamp_file).read().strip() if os.path.exists(stamp_file) else None
    now_hash = run(["sh", "-c", "find Sources Package.swift -type f -print0 | LC_ALL=C sort -z | "
                    "xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1"], cwd=os.path.join(ROOT, "macos")).stdout.strip()
    facts["appSourcesMatch"] = built_from == now_hash
    if not facts["appSourcesMatch"]:
        problems.append(f"the app was not built from the current macos/ sources ({CONFIG['buildHint']})")
    names = bots_by_name()
    missing = [n for n in CONFIG["fixtures"].values() if n not in names]
    if missing:
        problems.append(f"fixture bots missing: {', '.join(missing)} (run: perf/run.sh fixtures)")
    return facts, problems


# ---------------------------------------------------------------- one launch


class Launch:
    """One app launch running one scenario, recorded."""

    def __init__(self, app, outdir, name, steps, drop_snapshots=(), restore=None):
        self.app, self.name = app, name
        self.dir = os.path.join(outdir, name)
        os.makedirs(self.dir, exist_ok=True)
        self.marks_path = os.path.join(self.dir, "marks.jsonl")
        self.scenario = {
            "runId": f"{name}-{uuid.uuid4().hex[:8]}",
            "resultFile": self.marks_path,
            "dropSnapshots": list(drop_snapshots),
            "restoreBotId": restore,
            "steps": steps,
        }
        self.scenario_path = os.path.join(self.dir, "scenario.json")
        write_json(self.scenario_path, self.scenario)

    def execute(self, timeout_s=900, record=True):
        self.app.quit_all()
        time.sleep(1.0)
        self.t_launch = self.app.launch(self.scenario_path)
        pid = None
        for _ in range(300):
            pid = self.app.pid_of_this_copy()
            if pid:
                break
            time.sleep(0.02)
        if not pid:
            raise RuntimeError(f"{self.name}: the app never started")
        rec = None
        if record:
            crop = CONFIG["crop"]
            rec = subprocess.Popen(
                [os.path.join(PERF, ".build/perfrec"), "--pid", str(pid), "--title", CONFIG["windowTitle"],
                 "--min-height", str(CONFIG["minWindowHeight"]), "--seconds", str(timeout_s), "--out", self.dir,
                 "--fps", str(CONFIG["fps"]), "--scale", str(CONFIG["scale"]),
                 "--crop", f"{crop['left']},{crop['top']},{crop['right']},{crop['bottom']}"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            line = rec.stdout.readline()
            if not line.startswith("recording"):
                rec.kill()
                raise RuntimeError(f"{self.name}: recorder failed: {line}{rec.stderr.read()}")
            self.window = line.split()[1:]
        deadline = time.time() + timeout_s
        end = None
        # Other work is sampled every ~2 s while the launch runs: a burst in
        # the middle of a launch skews it as much as one before it.
        self.peak_cpu, self.peak_top = 0.0, []
        next_sample = 0.0
        try:
            while time.time() < deadline:
                if time.time() >= next_sample:
                    cpu, top = external_cpu()
                    if cpu > self.peak_cpu:
                        self.peak_cpu, self.peak_top = cpu, top
                    next_sample = time.time() + 2.0
                end = self.last_event({"quit", "done", "abort"})
                if end:
                    break
                if not self.app.running_pids():
                    # The app may have written its end mark and quit since the read above.
                    end = self.last_event({"quit", "done", "abort"}) or {"ev": "exited"}
                    break
                time.sleep(0.2)
        finally:
            if rec:
                time.sleep(0.3)
                rec.terminate()
                try:
                    rec.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    rec.kill()
        if end is None:
            raise RuntimeError(f"{self.name}: no end mark in {timeout_s}s")
        if end["ev"] == "abort":
            # The harness puts the owner's chat back after an abort; let that save.
            for _ in range(40):
                if self.scenario.get("restoreBotId") is None or self.last_event({"restored"}):
                    break
                # A dead app writes no more marks; stop waiting for one.
                if not self.app.running_pids():
                    break
                time.sleep(0.1)
            raise RuntimeError(f"{self.name}: the app aborted the scenario: {end.get('why')}")
        if end["ev"] == "exited":
            raise RuntimeError(f"{self.name}: the app exited before the scenario ended")
        if end["ev"] == "done":
            self.app.quit_all()
        return self

    def marks(self):
        if not os.path.exists(self.marks_path):
            return []
        out = []
        for line in open(self.marks_path):
            line = line.strip()
            if line:
                out.append(json.loads(line))
        return out

    def last_event(self, names):
        for m in reversed(self.marks()):
            if m["ev"] in names:
                return m
        return None

    def scores(self):
        path = os.path.join(self.dir, "scores.csv")
        rows = []
        if os.path.exists(path):
            for line in open(path):
                parts = line.strip().split(",")
                if len(parts) == 3:
                    rows.append((int(parts[1]), float(parts[2]), int(parts[0])))
        return rows


# ---------------------------------------------------------------- analysis


def visual_window(scores, start, end):
    """First and last frame inside [start, end) whose chat column changed."""
    changed = [t for t, s, _ in scores if start <= t < end and s > CONFIG["changeThreshold"]]
    if not changed:
        return None, None
    return changed[0], changed[-1]


def samples_from(launch, names_by_id):
    """One sample per measured step: select → landed (app) and → last change (pixels)."""
    marks, scores = launch.marks(), launch.scores()
    steps = [m for m in marks if m["ev"] == "step"]
    boundaries = [m["t"] for m in steps] + [m["t"] for m in marks if m["ev"] in ("quit", "done")]
    out = []

    def responsive_after(bot, landed_t):
        for m in marks:
            if m["ev"] == "responsive" and m["bot"] == bot and m["landedAt"] == landed_t:
                return m
        return None

    def sample(case, bot, t0, t_end):
        landed = next((m for m in marks if m["ev"] == "landed" and m["bot"] == bot and m["t"] >= t0), None)
        first, last = visual_window(scores, t0, t_end)
        s = {"case": case, "launch": launch.name, "bot": names_by_id.get(bot, bot), "t0": t0, "problems": []}
        if landed is None:
            s["problems"].append("never landed")
        else:
            probe = responsive_after(bot, landed["t"])
            for ev in ("replay_first_event", "replay_done", "publish_done"):
                m = next((m for m in marks if m["ev"] == ev and m.get("bot") == bot and t0 <= m["t"] <= landed["t"]), None)
                if m:
                    s[ev + "_ms"] = (m["t"] - t0) / 1e6
            s.update(app_ms=(landed["t"] - t0) / 1e6, reason=landed["reason"], source=landed.get("source"),
                     rows=landed.get("rows"), blocks=landed.get("blocks"), events=landed.get("events"),
                     stall_ms=probe["stallMaxMs"] if probe else None)
            if probe is None:
                s["problems"].append("no responsiveness mark after landing")
            elif probe["t"] > t_end:
                s["problems"].append("the responsiveness probe ran into the next step")
        if last is None:
            s["problems"].append("nothing changed on screen")
        else:
            s["visual_ms"] = (last - t0) / 1e6
            s["first_change_ms"] = (first - t0) / 1e6
            s["last_change_t"] = last
            quiet = (t_end - last) / 1e6
            if quiet < CONFIG["settleQuietMs"]:
                s["problems"].append(f"still changing {quiet:.0f} ms before the next step")
        return s

    init = next((m for m in marks if m["ev"] == "initial_selection"), None)
    # Only launches with every snapshot in place: a no-snapshot launch is slower
    # at opening Perf Short A too, and pooling the two hid a 2x launch regression.
    if launch.name.startswith("cold-cold_first_open") and init and steps:
        s = sample("cold_launch", init["bot"], launch.t_launch, steps[0]["t"])
        if s["bot"] != CONFIG["fixtures"]["shortA"]:
            s["problems"].append(f"opened on {s['bot']}, not {CONFIG['fixtures']['shortA']}")
        out.append(s)
    for i, step in enumerate(steps):
        if step["label"] in ("transit", "warmup", "park"):
            continue
        select = next((m for m in marks if m["ev"] == "select_start" and m["bot"] == step["bot"] and m["t"] >= step["t"]), None)
        if select is None:
            out.append({"case": step["label"], "launch": launch.name, "problems": ["no select_start mark"]})
            continue
        t_end = boundaries[i + 1] if i + 1 < len(boundaries) else launch.scores()[-1][0] if scores else step["t"]
        out.append(sample(step["label"], step["bot"], select["t"], t_end))
    prewarm = [m for m in marks if m["ev"] in ("prewarm_start", "prewarm_end")]
    for s in out:
        s["prewarmOverlap"] = any(s.get("t0", 0) <= m["t"] <= s.get("last_change_t", s.get("t0", 0)) for m in prewarm)
    return out


def stats(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "median": round(statistics.median(values), 1), "worst": round(max(values), 1),
            "best": round(min(values), 1)}


def summarize(samples):
    cases = {}
    for s in samples:
        cases.setdefault(s["case"], []).append(s)
    summary = {}
    for case, group in cases.items():
        summary[case] = {
            "visual_ms": stats([s.get("visual_ms") for s in group]),
            "app_ms": stats([s.get("app_ms") for s in group]),
            "stall_ms": stats([s.get("stall_ms") for s in group]),
            "sources": sorted({str(s.get("source")) for s in group}),
            "reasons": sorted({str(s.get("reason")) for s in group}),
            "problems": [f"{s['launch']}: {p}" for s in group for p in s["problems"]],
            "n": len(group),
        }
    return summary


def judge(summary, budgets):
    """Every breach, with the numbers. Empty means the run passed."""
    breaches = []
    for case, budget in budgets["cases"].items():
        got = summary.get(case)
        if got is None:
            breaches.append(f"{case}: not measured")
            continue
        for p in got["problems"]:
            breaches.append(f"{case}: {p}")
        for metric in ("visual_ms", "app_ms", "stall_ms"):
            limit, measured = budget.get(metric), got.get(metric)
            if not limit:
                continue
            if measured is None:
                breaches.append(f"{case}: {metric} not measured")
                continue
            if "median" in limit and measured["median"] > limit["median"]:
                breaches.append(f"{case}: {metric} median {measured['median']} > {limit['median']}")
            if "worst" in limit and measured["worst"] > limit["worst"]:
                breaches.append(f"{case}: {metric} worst {measured['worst']} > {limit['worst']}")
        # A landing that ran out its cap is a failure unless the budget names
        # it as a known state of that case.
        wrong = [r for r in got["reasons"] if r not in budget.get("reasons", ["settled", "sent"])]
        if wrong:
            breaches.append(f"{case}: landing ended by {', '.join(wrong)}")
        allowed = budget.get("sources")
        if allowed:
            wrong = [s for s in got["sources"] if s not in allowed]
            if wrong:
                breaches.append(f"{case}: took the {', '.join(wrong)} path, expected {', '.join(allowed)}")
    return breaches


def fixture_check(samples, lock):
    """A fixture that grew or moved session measures a different chat."""
    problems = []
    names = bots_by_name()
    for name, locked in lock.get("bots", {}).items():
        bot = names.get(name)
        if bot is None:
            problems.append(f"fixture {name} is gone")
            continue
        if bot.get("sessionId") != locked["sessionId"]:
            problems.append(f"fixture {name} is on a new session (was {locked['sessionId']})")
        seen = [s["events"] for s in samples if s.get("bot") == name and isinstance(s.get("events"), int) and s["events"] >= 0]
        if not seen:
            problems.append(f"fixture {name}: no landing reported its event count")
        elif max(seen) != locked["events"]:
            problems.append(f"fixture {name} has {max(seen)} events, locked at {locked['events']}")
    return problems


def sheet(launch, sample, out_path):
    """Tile the frames from the select to the settle, so a blank, mascot or jump can be seen."""
    t0, t1 = sample.get("t0"), sample.get("last_change_t")
    if t0 is None or t1 is None:
        return None
    frames = sorted(os.listdir(os.path.join(launch.dir, "frames")))
    picked = []
    for f in frames:
        t = int(f.split("_")[1][:-4])
        if t0 - 50_000_000 <= t <= t1 + 50_000_000:
            picked.append(f)
    if not picked:
        return None
    if len(picked) > 24:
        step = len(picked) / 24
        picked = [picked[int(i * step)] for i in range(23)] + [picked[-1]]
    tmp = tempfile.mkdtemp()
    for i, f in enumerate(picked):
        shutil.copy(os.path.join(launch.dir, "frames", f), os.path.join(tmp, f"t{i:02d}.jpg"))
    cols = 4
    rows = (len(picked) + cols - 1) // cols
    run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", "1", "-i", os.path.join(tmp, "t%02d.jpg"),
         "-vf", f"scale=420:-1,tile={cols}x{rows}:padding=4:color=black", "-frames:v", "1", out_path])
    shutil.rmtree(tmp, ignore_errors=True)
    return [round((int(f.split("_")[1][:-4]) - t0) / 1e6) for f in picked]


# ---------------------------------------------------------------- scenarios


def fixture_ids():
    names = bots_by_name()
    return {key: names[name]["id"] for key, name in CONFIG["fixtures"].items() if name in names}


def step(op, bot=None, label=None, ms=None, text=None):
    s = {"op": op}
    if bot:
        s["bot"] = bot
    if label:
        s["label"] = label
    if ms is not None:
        s["ms"] = ms
    if text:
        s["text"] = text
    return s


def select(key, label):
    return [step("select", CONFIG["fixtures"][key], label), step("pause", ms=CONFIG["pauseMs"])]


def park():
    """Leave the app on the short fixture, so the next cold launch opens there."""
    return [step("select", CONFIG["fixtures"]["shortA"], "park"), step("pause", ms=1500), step("quit")]


def plan(quick):
    runs = CONFIG["runs"]
    cold, nosnap = (2, 1) if quick else (runs["cold"], runs["coldNoSnapshot"])
    warm_short, warm_long = (4, 6) if quick else (runs["warmShort"], runs["warmLong"])
    launches = [("prep", [s for k in ("longTools", "longReplies", "shortB") for s in select(k, "warmup")]
                 + [step("wait_prewarm"), step("pause", ms=2000)] + park(), ())]
    for i in range(cold):
        for key, case in (("longTools", "cold_first_open_tools"), ("longReplies", "cold_first_open_replies")):
            launches.append((f"cold-{case}-{i + 1}", [step("pause", ms=CONFIG["pauseMs"])] + select(key, case) + park(), ()))
    ids = fixture_ids()
    for i in range(nosnap):
        for key, case in (("longTools", "cold_no_snapshot_tools"), ("longReplies", "cold_no_snapshot_replies")):
            launches.append((f"cold-{case}-{i + 1}", [step("pause", ms=CONFIG["pauseMs"])] + select(key, case) + park(), (ids[key],)))
    warm = []
    for key in ("longTools", "longReplies", "shortB", "longTools", "longReplies", "shortA"):
        warm += select(key, "warmup")
    for i in range(warm_short):
        warm += select("shortB" if i % 2 == 0 else "shortA", "warm_switch_short")
    if warm_short % 2 == 1:
        warm += select("shortA", "transit")
    for i in range(warm_long):
        warm += select("longTools", "warm_return_tools") + select("shortA", "transit")
        warm += select("longReplies", "warm_return_replies") + select("shortA", "transit")
    launches.append(("warm", warm + [step("restore"), step("pause", ms=1500), step("quit")], ()))
    return launches


# ---------------------------------------------------------------- commands


def measure(args, quick):
    app = App(args.app or CONFIG["app"])
    facts, problems = preflight(app)
    if problems:
        for p in problems:
            print(f"preflight: {p}")
        sys.exit(2)
    owner = owner_selection()
    was_running = [p for p in app.running_pids()]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    outdir = os.path.join(PERF, ".runs", stamp)
    os.makedirs(outdir, exist_ok=True)
    # A display that sleeps or locks mid-run stops rendering the window.
    subprocess.Popen(["caffeinate", "-diu", "-w", str(os.getpid())])
    print(f"run {stamp}: {app.path}\n  frames and marks in {os.path.relpath(outdir, ROOT)}")
    ids = {b["id"]: b["name"] for b in shell_state()["bots"]}
    samples, failures, done, loads = [], [], [], []
    started = time.time()
    try:
        for name, steps, drop in plan(quick):
            restore = owner if name == "warm" else None
            launch = Launch(app, outdir, name, steps, drop, restore)
            before, before_top = external_cpu()
            try:
                selects = sum(1 for st in steps if st["op"] == "select")
                launch.execute(timeout_s=max(300, selects * 45))
            except RuntimeError as err:
                launch_peak = getattr(launch, "peak_cpu", 0.0)
                peak, peak_top = (launch_peak, launch.peak_top) if launch_peak > before else (before, before_top)
                loads.append((name, round(peak), peak_top))
                failures.append(str(err))
                print(f"  {name}: FAILED {err}")
                continue
            # The busiest sample of the launch, the one before it included.
            peak, peak_top = (launch.peak_cpu, launch.peak_top) if launch.peak_cpu > before else (before, before_top)
            loads.append((name, round(peak), peak_top))
            done.append(launch)
            if name != "prep":
                got = samples_from(launch, ids)
                samples += got
                print(f"  {name}: " + ", ".join(f"{s['case']} {s.get('visual_ms', 0):.0f} ms" for s in got))
    finally:
        # Put the owner's app back the way it was found.
        if was_running:
            app.quit_all()
            installed = CONFIG.get("installedApp")
            subprocess.run(["open", "-g", "-a", os.path.expanduser(installed) if installed else app.path])
    cpu, top = external_cpu()
    loads.append(("end", round(cpu), top))
    facts["externalCpuDuringRun"] = loads
    busy = [f"{n} {c}% ({'; '.join(t)})" for n, c, t in loads if c > CONFIG["maxExternalCpu"]]
    facts["busy"] = busy
    summary = summarize(samples)
    return app, facts, outdir, stamp, samples, summary, failures, done, time.time() - started


def report(args, kind, app, facts, outdir, stamp, samples, summary, failures, done, seconds, breaches):
    by_launch = {l.name: l for l in done}
    sheets = {}
    for case in summary:
        group = [s for s in samples if s["case"] == case and s.get("visual_ms") is not None]
        if not group:
            continue
        worst = max(group, key=lambda s: s["visual_ms"])
        path = os.path.join(outdir, f"sheet-{case}.jpg")
        offsets = sheet(by_launch[worst["launch"]], worst, path)
        if offsets:
            sheets[case] = {"file": os.path.basename(path), "launch": worst["launch"], "frameOffsetsMs": offsets}
    result = {"kind": kind, "stamp": stamp, "facts": facts, "seconds": round(seconds), "summary": summary,
              "breaches": breaches, "failures": failures, "sheets": sheets, "samples": samples,
              "command": " ".join(sys.argv[1:])}
    write_json(os.path.join(outdir, "report.json"), result)
    return write_record(outdir)


def verdict(result):
    if result["facts"].get("busy"):
        return "INCONCLUSIVE (machine busy, re-run when it is quiet)"
    return "FAIL" if result["breaches"] or result["failures"] else "PASS"


def write_record(outdir):
    """The committed record of one run, rebuilt from its run folder alone."""
    result = load_json(os.path.join(outdir, "report.json"))
    kind, stamp, facts, summary = result["kind"], result["stamp"], result["facts"], result["summary"]
    breaches, failures, seconds = result["breaches"], result["failures"], result["seconds"]
    # The numbers, marks and sheets. Frames stay in perf/.runs (too big to commit).
    # The time is in the name: two runs on one commit in one day must not share a folder.
    date = stamp[:10]
    sha = facts["gitSha"][:7]
    dest = os.path.join(ROOT, CONFIG["resultsDir"], f"{date}-perf-{kind}-{stamp[11:15]}-{sha}")
    os.makedirs(dest, exist_ok=True)
    shutil.copy(os.path.join(outdir, "report.json"), dest)
    for name in sorted(os.listdir(outdir)):
        marks = os.path.join(outdir, name, "marks.jsonl")
        if os.path.exists(marks):
            shutil.copy(marks, os.path.join(dest, f"marks-{name}.jsonl"))
    for s in result["sheets"].values():
        shutil.copy(os.path.join(outdir, s["file"]), dest)
    lines = [f"# Performance {kind}, {date} {stamp[11:13]}:{stamp[13:15]} ({sha})", "",
             f"App `{facts['app']}` (sha256 {facts['appSha256'][:12]}), git {facts['gitSha'][:12]}"
             + (" with uncommitted changes" if facts["gitDirty"] else "") + f", macOS {facts['macOS']}, {facts['machine']}.",
             f"Power {facts['power']}, memory free {facts['memoryFree']}, load {facts['loadAverage']}, "
             f"other work {facts.get('externalCpu', '?')}% CPU, web {facts['webMode']}.",
             f"Command: `perf/run.sh {result['command']}`. Took {round(seconds)} s.", "",
             "| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |",
             "|---|---|---|---|---|---|---|---|---|"]
    for case, got in sorted(summary.items()):
        v, a, st = got["visual_ms"] or {}, got["app_ms"] or {}, got["stall_ms"] or {}
        lines.append(f"| {case} | {got['n']} | {v.get('median', '-')} | {v.get('worst', '-')} | {a.get('median', '-')} | "
                     f"{a.get('worst', '-')} | {st.get('worst', '-')} | {', '.join(got['sources'])} | {', '.join(got.get('reasons', []))} |")
    lines += ["", "Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.",
              "Stall: the longest main-thread delay in the second after landing. All in ms.", ""]
    if breaches:
        lines += ["## Breaches", ""] + [f"- {b}" for b in breaches] + [""]
    if failures:
        lines += ["## Launch failures", ""] + [f"- {f}" for f in failures] + [""]
    if facts.get("busy"):
        lines += [f"## Machine busy during the run (other work over {CONFIG['maxExternalCpu']}% CPU)", ""]
        lines += [f"- {b}" for b in facts["busy"]] + [""]
    if kind == "check":
        lines += ["**Result: " + verdict(result) + "**", ""]
    with open(os.path.join(dest, "README.md"), "w") as f:
        f.write("\n".join(lines))
    print("\n".join(lines))
    print(f"record: {os.path.relpath(dest, ROOT)}")
    return dest


def cmd_check(args):
    budgets = load_json(os.path.join(PERF, "budgets.json"))
    lock = load_json(os.path.join(PERF, "fixtures.lock.json"))
    app, facts, outdir, stamp, samples, summary, failures, done, seconds = measure(args, args.quick)
    breaches = judge(summary, budgets) + fixture_check(samples, lock)
    report(args, "check", app, facts, outdir, stamp, samples, summary, failures, done, seconds, breaches)
    # 3: inconclusive. A breach on a busy machine is not evidence either way.
    sys.exit(3 if facts["busy"] else 1 if breaches or failures else 0)


def cmd_baseline(args):
    lock = load_json(os.path.join(PERF, "fixtures.lock.json"))
    app, facts, outdir, stamp, samples, summary, failures, done, seconds = measure(args, False)
    problems = fixture_check(samples, lock) + [f"{c}: {p}" for c, g in summary.items() for p in g["problems"]]
    dest = report(args, "baseline", app, facts, outdir, stamp, samples, summary, failures, done, seconds, problems)
    # Proposed, never applied: budgets change by a reviewed edit to budgets.json.
    proposal = {"proposedFrom": os.path.relpath(dest, ROOT), "cases": {}}
    rule = CONFIG["budgetRule"]
    for case, got in summary.items():
        entry = {"sources": got["sources"], "reasons": got["reasons"]}
        for metric in ("visual_ms", "app_ms", "stall_ms"):
            m = got[metric]
            if not m:
                continue
            median = round(m["median"] * rule["medianFactor"] + rule["floorMs"], -1)
            worst = round(max(m["worst"] * rule["worstFactor"], median * rule["worstOverMedian"]), -1)
            if metric == "stall_ms":
                # Stalls bunch tightly, so worst comes from the worst alone (the
                # median rule let them grow 65-96% unnoticed) and the median is
                # gated too. A single GC pause is tens of ms; below the floor a
                # stall isn't felt.
                stall_median = max(median, rule["stallFloorMs"])
                entry[metric] = {"median": stall_median,
                                 "worst": max(round(m["worst"] * rule["worstFactor"], -1), stall_median)}
            else:
                entry[metric] = {"median": median, "worst": worst}
        proposal["cases"][case] = entry
    write_json(os.path.join(PERF, "budgets.proposed.json"), proposal)
    print("proposed budgets: perf/budgets.proposed.json (review, then copy what you accept into budgets.json)")
    if facts["busy"]:
        print("the machine was busy during the baseline: do not take budgets from it")
    sys.exit(3 if facts["busy"] else 1 if problems or failures else 0)


def cmd_fixtures(args):
    """Create the fixture bots and send their scripted turns, once."""
    app = App(args.app or CONFIG["app"])
    spec = load_json(os.path.join(PERF, "fixtures.json"))
    names = bots_by_name()
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    outdir = os.path.join(PERF, ".runs", f"fixtures-{stamp}")
    owner = owner_selection()
    for key, name in CONFIG["fixtures"].items():
        turns = spec[key]["turns"]
        bot = names.get(name)
        if args.resume and args.resume[0] == key:
            turns = turns[int(args.resume[1]) - 1:]
        elif bot and bot.get("sessionId"):
            print(f"{name}: already has a chat, left as it is")
            continue
        steps = [step("create", name)]
        level = spec[key].get("permission")
        if level and (bot or {}).get("permission") != level:
            # The harness never raises a permission: the owner sets it in the app.
            sys.exit(f"{name}: set its permission to {level} in the app first (the permission menu under the composer)")
        for text in turns:
            steps.append(step("send", name, text=text))
        steps += [step("restore"), step("pause", ms=1500), step("quit")]
        print(f"{name}: {len(turns)} turns")
        launch = Launch(app, outdir, key, steps, restore=owner)
        launch.execute(timeout_s=len(turns) * 900 + 120, record=False)
        for m in launch.marks():
            if m["ev"] in ("ready", "send_done"):
                print("  ", json.dumps({k: v for k, v in m.items() if k in ("ev", "index", "stats", "modelLabel")}))
    print("now run: perf/run.sh lock")


def cmd_lock(args):
    """Open each fixture once and record its session and event count."""
    app = App(args.app or CONFIG["app"])
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    outdir = os.path.join(PERF, ".runs", f"lock-{stamp}")
    steps = []
    for key in ("longTools", "longReplies", "shortB", "shortA"):
        steps += [step("select", CONFIG["fixtures"][key], "lock"), step("pause", ms=6000)]
    launch = Launch(app, outdir, "lock", steps + [step("restore"), step("pause", ms=1500), step("quit")],
                    restore=owner_selection()).execute(record=False)
    ids = {b["id"]: b for b in shell_state()["bots"]}
    lock = {"lockedAt": stamp, "bots": {}}
    for m in launch.marks():
        if m["ev"] == "landed" and m["bot"] in ids and ids[m["bot"]]["name"] in CONFIG["fixtures"].values():
            bot = ids[m["bot"]]
            lock["bots"][bot["name"]] = {"sessionId": bot.get("sessionId"), "events": m.get("events"),
                                         "rows": m.get("rows"), "blocks": m.get("blocks")}
    write_json(os.path.join(PERF, "fixtures.lock.json"), lock)
    print(json.dumps(lock, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "baseline", "fixtures", "lock"):
        p = sub.add_parser(name)
        p.add_argument("--app", help="the .app to measure (default: config.json app)")
        if name == "check":
            p.add_argument("--quick", action="store_true", help="fewer runs, for trying the rig; not a merge gate")
        if name == "fixtures":
            p.add_argument("--resume", nargs=2, metavar=("KEY", "TURN"),
                           help="send one fixture's turns from TURN on, into its existing chat")
    args = ap.parse_args()
    {"check": cmd_check, "baseline": cmd_baseline, "fixtures": cmd_fixtures, "lock": cmd_lock}[args.cmd](args)


if __name__ == "__main__":
    main()
