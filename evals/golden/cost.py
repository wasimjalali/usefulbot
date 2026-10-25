#!/usr/bin/env python3
"""Cost of a golden run, from the router's own usage records (read only).

    python3 evals/golden/cost.py --run-id 2026-10-25-eve

Reads evals/golden/runs/<run-id>/<task-id>.json for each task's time window, opens the dev router's
usage.sqlite read only, sums input and output tokens per task and prices them from prices.json.
Writes evals/golden/runs/<run-id>/cost.json and prints a table.

The usage table (router/usage.sqlite) has one row per model request:
    usage(id, caller_id, provider, model, input_tokens, output_tokens, ts)   ts = epoch ms
It has no cache-hit split, so input is priced at the cache-miss rate (an upper bound, see
prices.json). Rows from any other model in a task's window are listed under `other_models` and
are not priced.
"""
import argparse
import datetime as dt
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.expanduser("~/.useful-bot-dev-app/router/usage.sqlite")
# A usage row can land a moment after the turn's last idle sample; the window is
# extended by this much, but never past the next task's first send.
TAIL_MS = 10_000


def is_peak(ts_ms: int, prices: dict) -> bool:
    t = dt.datetime.fromtimestamp(ts_ms / 1000, dt.timezone.utc)
    if t.weekday() > 4:  # Mon=0 .. Fri=4
        return False
    minutes = t.hour * 60 + t.minute
    for start, end in prices["peak_utc"]["windows"]:
        s = int(start[:2]) * 60 + int(start[3:])
        e = int(end[:2]) * 60 + int(end[3:])
        if s <= minutes < e:
            return True
    return False


def price_row(row: dict, prices: dict) -> float:
    per = prices["per_million_tokens"]
    band = "peak" if is_peak(row["ts"], prices) else "offpeak"
    return (
        row["input_tokens"] * per["input_cache_miss"][band]
        + row["output_tokens"] * per["output"][band]
    ) / 1_000_000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--db", default=DEFAULT_DB, help="router usage.sqlite (opened read only)")
    ap.add_argument("--prices", default=os.path.join(HERE, "prices.json"))
    args = ap.parse_args()

    run_dir = os.path.join(HERE, "runs", args.run_id)
    prices = json.load(open(args.prices))
    if "placeholder" in json.dumps(prices).lower():
        print("prices.json still holds placeholders: fill it from the vendor page first", file=sys.stderr)
        return 2
    records = []
    for name in sorted(os.listdir(run_dir)):
        if name.endswith(".json") and name.count(".") == 1 and name[:3] in {f"t{i:02d}" for i in range(1, 11)}:
            records.append(json.load(open(os.path.join(run_dir, name))))
    if not records:
        print(f"no task records in {run_dir}", file=sys.stderr)
        return 2
    records.sort(key=lambda r: r["window_ms"]["start"])

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out = {"run_id": args.run_id, "prices": os.path.relpath(args.prices, HERE), "db": args.db, "tasks": {}}
    total = {"input_tokens": 0, "output_tokens": 0, "requests": 0, "usd": 0.0}
    for i, rec in enumerate(records):
        start = rec["window_ms"]["start"]
        end = rec["window_ms"]["end"] + TAIL_MS
        if i + 1 < len(records):
            end = min(end, records[i + 1]["window_ms"]["start"])
        rows = [dict(r) for r in con.execute(
            "SELECT caller_id, provider, model, input_tokens, output_tokens, ts FROM usage "
            "WHERE ts >= ? AND ts < ? ORDER BY ts", (start, end))]
        hits = con.execute("SELECT COUNT(*) FROM search_hits WHERE ts >= ? AND ts < ?", (start, end)).fetchone()[0]
        priced = [r for r in rows if r["provider"] == prices["provider"] and r["model"] == "deepseek-flash"]
        other = {}
        for r in rows:
            if r not in priced:
                key = f'{r["provider"]}/{r["model"]}'
                other[key] = other.get(key, 0) + 1
        t = {
            "requests": len(priced),
            "input_tokens": sum(r["input_tokens"] for r in priced),
            "output_tokens": sum(r["output_tokens"] for r in priced),
            "usd": round(sum(price_row(r, prices) for r in priced), 6),
            "peak_requests": sum(1 for r in priced if is_peak(r["ts"], prices)),
            "callers": sorted({r["caller_id"] for r in priced}),
            "search_hits": hits,
            "other_models": other,
            "window_ms": [start, end],
        }
        out["tasks"][rec["task_id"]] = t
        for k in ("input_tokens", "output_tokens", "requests"):
            total[k] += t[k]
        total["usd"] += t["usd"]
    total["usd"] = round(total["usd"], 6)
    out["total"] = total
    out["note"] = "Input is priced at the cache-miss rate (the router does not record cache hits): an upper bound."
    path = os.path.join(run_dir, "cost.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

    print(f'{"task":<22}{"req":>5}{"input":>10}{"output":>9}{"usd":>10}  notes')
    for tid, t in out["tasks"].items():
        notes = []
        if t["other_models"]:
            notes.append("other models: " + ", ".join(f"{k} x{v}" for k, v in t["other_models"].items()))
        if t["requests"] == 0:
            notes.append("NO usage rows in window")
        if t["search_hits"]:
            notes.append(f'{t["search_hits"]} search hits')
        print(f'{tid:<22}{t["requests"]:>5}{t["input_tokens"]:>10}{t["output_tokens"]:>9}{t["usd"]:>10.4f}  {"; ".join(notes)}')
    print(f'{"total":<22}{total["requests"]:>5}{total["input_tokens"]:>10}{total["output_tokens"]:>9}{total["usd"]:>10.4f}')
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
