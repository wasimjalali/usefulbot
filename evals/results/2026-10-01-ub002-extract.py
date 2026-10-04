#!/usr/bin/env python3
"""Pull the router's upstream_usage lines for a time window and summarise them per model.

Usage:
  python3 evals/results/2026-10-01-ub002-extract.py \
    ~/Library/Logs/UsefulBotDev/service-router.log 2026-10-01T15:09 2026-10-01T15:18 \
    > evals/results/2026-10-01-ub002-model-switching-usage.jsonl
  python3 evals/results/2026-10-01-ub002-extract.py --summary \
    evals/results/2026-10-01-ub002-model-switching-usage.jsonl

A call whose cachedInputTokens is null means the provider did not report it, not a miss.
"""
import json
import statistics
import sys


def extract(log, start, end):
    for line in open(log):
        if '"upstream_usage"' not in line:
            continue
        row = json.loads(line)
        if start <= row["time"] < end:
            print(json.dumps(row))


def summary(path):
    rows = [json.loads(line) for line in open(path)]
    print(f"calls {len(rows)}  input {sum(r['inputTokens'] for r in rows)}  "
          f"cached {sum(r['cachedInputTokens'] or 0 for r in rows)}  output {sum(r['outputTokens'] for r in rows)}")
    for model in sorted({r["modelId"] for r in rows}):
        rs = [r for r in rows if r["modelId"] == model]
        unreported = [r for r in rs if r["cachedInputTokens"] is None]
        miss = [r for r in rs if r["cachedInputTokens"] == 0]
        hit = [r for r in rs if r["cachedInputTokens"]]
        med = lambda xs: round(statistics.median(x["ttfbMs"] for x in xs)) if xs else None
        share = sum(r["cachedInputTokens"] or 0 for r in rs) / sum(r["inputTokens"] for r in rs)
        print(f"{model}: calls {len(rs)}  unreported {len(unreported)}  miss {len(miss)} (ttfb {med(miss)})  "
              f"hit {len(hit)} (ttfb {med(hit)})  cached share {share:.1%}")


if __name__ == "__main__":
    if sys.argv[1] == "--summary":
        summary(sys.argv[2])
    else:
        extract(*sys.argv[1:4])
