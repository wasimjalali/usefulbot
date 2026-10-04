#!/bin/bash
S=$(cd "$(dirname "$0")" && pwd)
C="$HOME/Library/Application Support/Useful Bot Dev/app/.eve/.workflow-data/streams/chunks"
send_wait() {
  node "$S/probe2.mjs" "$1" >/dev/null
  P=$(python3 -c "import json;d=json.load(open('$HOME/.useful-bot-dev-app/shell.json'));print([b['sessionId'] for b in d['bots'] if b['name']=='Test Bot'][0])")
  for t in $(seq 1 60); do sleep 3; python3 "$S/decode.py" "$C/strm_${P#wrun_}_user" "$S/beh.jsonl" >/dev/null
    python3 - "$1" <<'PY' && break
import json,sys
rows=[json.loads(l)['ev'] for l in open(sys.argv[0].replace('-','') or 'x')] if False else [json.loads(l)['ev'] for l in open(__import__('os').environ['BEH'])]
msg=sys.argv[1]
idx=max(i for i,e in enumerate(rows) if e['type']=='message.received' and e['data'].get('message','').endswith(msg)) if any(e['type']=='message.received' and e['data'].get('message','').endswith(msg) for e in rows) else None
if idx is None: sys.exit(1)
tail=rows[idx:]
done=[e for e in tail if e['type'] in ('turn.completed','turn.failed','input.requested','turn.cancelled')]
if not done: sys.exit(1)
tools=[a.get('toolName') for e in tail if e['type']=='actions.requested' for a in e['data'].get('actions',[])]
text=' | '.join(e['data'].get('message','') for e in tail if e['type']=='message.completed')
print(json.dumps({"q":msg,"tools":tools,"end":done[0]['type'],"reply":text[:900]}))
PY
  done
}
export BEH="$S/beh.jsonl"
for q in "How do I connect my Gmail so you can read my mail?" "I have an MCP server URL. How do I add it?" "Can you work in Notion for me?"; do send_wait "$q"; done
