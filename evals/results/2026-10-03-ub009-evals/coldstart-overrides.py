#!/usr/bin/env python3
"""Apply the DEV-ONLY cold-start overrides to the working tree (never commit them).

The overrides read ~/.useful-bot-dev-app/coldstart-mode on every request:
  (missing or empty)  normal behaviour
  defer    the proxy writes the new session's binding 4 s after eve created it,
           without waiting, so the first turn runs before the binding exists
  skip     the proxy never writes the binding; only the turn's bot claim can
  noclaim  `skip`, and owner tokens carry no bot claim at all

usage: coldstart-overrides.py apply   (then npm run build:dev-app && npm run install:dev-app)
revert with: git checkout -- web/lib/agent-exec.ts 'web/app/eve/v1/[...path]/route.ts'
Every edit asserts it matched exactly once.
"""
import sys

ROUTE = "web/app/eve/v1/[...path]/route.ts"
EXEC = "web/lib/agent-exec.ts"
MODE = "coldstartMode()"
HELPER = ('\nfunction coldstartMode(): string {\n'
          '  const f = coldstartHome() + "/.useful-bot-dev-app/coldstart-mode";\n'
          '  return coldstartExists(f) ? coldstartRead(f, "utf8").trim() : "";\n}\n')
IMPORTS = ('import { existsSync as coldstartExists, readFileSync as coldstartRead } from "node:fs";\n'
           'import { homedir as coldstartHome } from "node:os";\n')


def edit(path, old, new):
    text = open(path).read()
    assert text.count(old) == 1, f"{path}: expected one match for {old[:60]!r}, found {text.count(old)}"
    open(path, "w").write(text.replace(old, new))


if sys.argv[1:] != ["apply"]:
    raise SystemExit(__doc__)

for path in (ROUTE, EXEC):
    text = open(path).read()
    assert "coldstartMode" not in text, f"{path}: overrides already applied"
    open(path, "w").write(IMPORTS + text + HELPER)

edit(ROUTE,
     "        try {\n          bindSession(created, route.threadId);\n        } catch (err) {",
     "        const coldMode = " + MODE + ";\n"
     "        console.error(JSON.stringify({ coldstart_override: coldMode || \"normal\", session: created }));\n"
     "        try {\n"
     "          if (coldMode === \"defer\") {\n"
     "            const sid = created, bot = route.threadId;\n"
     "            setTimeout(() => { try { bindSession(sid, bot); } catch (e) { console.error(\"coldstart deferred bind\", e); } }, 4000);\n"
     "          } else if (coldMode !== \"skip\" && coldMode !== \"noclaim\") {\n"
     "            bindSession(created, route.threadId);\n"
     "          }\n"
     "        } catch (err) {")

edit(EXEC,
     "    ...(botId === null ? {} : { botId }),",
     "    ...(botId === null || (" + MODE + ") === \"noclaim\" ? {} : { botId }),")

edit(EXEC,
     "  const key = `${botId ?? \"\"}\\u0000${delivery}`;",
     "  const key = `${botId ?? \"\"}\\u0000${delivery}\\u0000${" + MODE + "}`;")

print("applied: route bind override, claim override, token cache keyed by mode")
