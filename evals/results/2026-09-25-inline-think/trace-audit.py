"""Count, per model and provider, how many eve trace segments carry a raw
`<think>` in the answer text and how many carry proper reasoning parts.

Run from the repo root:  python3 evals/results/2026-09-25-inline-think/trace-audit.py
Reads .eve/traces/v1 (local only, not committed). The model comes from the
turn identity line eve puts in every system prompt ("runs on X (id) through Y").
"""
import collections
import os
import re

ROOT = ".eve/traces/v1"
think = collections.Counter()
total = collections.Counter()
reasoning = collections.Counter()
for dirpath, _, files in os.walk(ROOT):
    for name in files:
        text = open(os.path.join(dirpath, name), errors="ignore").read()
        ids = re.findall(r"runs on ([^()]{2,60}\([a-z0-9.\-/_]+\)) (?:through|via) ([A-Za-z0-9 .]+?)[.,]", text)
        if not ids:
            continue
        model = " | ".join(ids[-1])
        total[model] += 1
        if "<think>" in text:
            think[model] += 1
        if re.search(r'type\\?"\s*:\s*\\?"reasoning', text):
            reasoning[model] += 1
for model, _ in total.most_common():
    print(f"{model[:60]:60} segs={total[model]:4} think={think[model]:3} reasoning={reasoning[model]:4}")
