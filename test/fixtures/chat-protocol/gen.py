#!/usr/bin/env python3
"""Writes the chat protocol v1 fixtures (see README.md). Deterministic: rerun after an edit."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EPOCH = "e7a1c0de-0000-4000-8000-000000000001"
CHAT = "c4a7f00d-1111-4111-8111-111111111111"
ROUTINE_CHAT = "c4a7f00d-2222-4222-8222-222222222222"
T1 = "7a1e0001-0000-4000-8000-00000000a001"
T2 = "7a1e0001-0000-4000-8000-00000000a002"
T3 = "7a1e0001-0000-4000-8000-00000000a003"
T4 = "7a1e0001-0000-4000-8000-00000000a004"
C1 = "c1c1c1c1-0000-4000-8000-0000000000c1"
C2 = "c1c1c1c1-0000-4000-8000-0000000000c2"
C3 = "c1c1c1c1-0000-4000-8000-0000000000c3"
Q1 = "q1q1q1q1-0000-4000-8000-0000000000q1".replace("q", "a")
SEARCH = [
    {"title": "Pi agent harness", "url": "https://example.com/pi", "snippet": "An embeddable agent loop."},
    {"title": "Session format", "url": "https://example.com/pi/sessions", "snippet": "Append-only JSONL."},
]


def at(second):
    return f"2026-10-25T12:00:{second:02d}.000Z"


class Stream:
    def __init__(self, chat=CHAT, seq=0):
        self.chat = chat
        self.seq = seq
        self.lines = []
        self.second = 0

    def ready(self, tail_seq, resync, running=None):
        self.lines.append({"seq": self.seq, "epoch": EPOCH, "at": at(self.second), "chatId": self.chat,
                           "type": "stream.ready", "tailSeq": tail_seq, "resync": resync, "running": running})

    def ping(self):
        self.lines.append({"seq": self.seq, "epoch": EPOCH, "at": at(self.second), "chatId": self.chat, "type": "ping"})

    def emit(self, type_, turn=None, **fields):
        self.seq += 1
        self.second += 1
        event = {"seq": self.seq, "epoch": EPOCH, "at": at(self.second), "chatId": self.chat}
        if turn:
            event["turnId"] = turn
        event["type"] = type_
        event.update(fields)
        self.lines.append(event)

    def write(self, name):
        with open(os.path.join(HERE, name), "w") as f:
            for line in self.lines:
                f.write(json.dumps(line, separators=(",", ":")) + "\n")


def write_json(name, value):
    with open(os.path.join(HERE, name), "w") as f:
        json.dump(value, f, indent=2)
        f.write("\n")


def user(turn, text, client, second, attachments=None, queued=False):
    row = {"rowId": f"{turn}:u", "kind": "user", "turnId": turn, "at": at(second), "text": text,
           "clientId": client, "attachments": attachments or []}
    if queued:
        row["queued"] = True
    return row


def assistant(turn, n, text, second, search=None):
    row = {"rowId": f"{turn}:a{n}", "kind": "assistant", "turnId": turn, "at": at(second), "text": text}
    if search:
        row["searchResults"] = search
    return row


QUESTION = {"requestId": Q1, "prompt": "Which folder should I save the report in?",
            "options": [{"id": "desktop", "label": "Desktop"},
                        {"id": "docs", "label": "Documents", "detail": "~/Documents/Reports"}],
            "allowFreeform": True}

IMAGE_ROW = {"rowId": "image:img-0001", "kind": "image", "turnId": T1, "at": at(9),
             "imageId": "img-0001", "prompt": "A small robot reading a map"}
WIDGET_ROW = {"rowId": "widget:call-excal-1", "kind": "widget", "turnId": T1, "at": at(8),
              "widgetId": "wdg-0001", "callId": "call-excal-1", "connectionId": "excalidraw",
              "toolName": "create_view"}


# rows-page.json: every row kind, newest page
rows = [
    {"rowId": "compaction:e-0042", "kind": "note", "turnId": None, "at": at(0),
     "text": "Conversation compacted to fit the model's window", "source": "compaction"},
    {"rowId": "note:connected-gmail", "kind": "note", "turnId": None, "at": at(1),
     "text": "Connected Gmail.", "source": "connect"},
    {"rowId": "card:prop-0001", "kind": "card", "turnId": None, "at": at(2), "proposalId": "prop-0001"},
    user(T1, "Find two sources on Pi and draw the flow", C1, 3,
         attachments=[{"name": "notes.txt", "mediaType": "text/plain", "size": 812}]),
    assistant(T1, 0, "Here are two sources.", 6, search=SEARCH),
    {"rowId": "page:media-0001", "kind": "page", "turnId": T1, "at": at(7), "mediaId": "media-0001",
     "title": "Pi notes", "path": "/Users/owner/Desktop/pi-notes.html"},
    WIDGET_ROW,
    IMAGE_ROW,
    assistant(T1, 1, "I drew the flow and saved a page.", 10),
    {"rowId": f"{T1}:q", "kind": "question", "turnId": T1, "at": at(11), **QUESTION, "open": False},
    user(T2, "Desktop", C2, 12),
    {"rowId": f"{T2}:f", "kind": "failure", "turnId": T2, "at": at(14), "code": "upstream_unavailable",
     "detail": "The provider didn't answer.", "retryAfterMs": 4000, "messageKept": True},
    {"rowId": "unsent:" + C3, "kind": "unsent", "turnId": None, "at": at(15), "clientId": C3,
     "text": "and email it to me", "reason": "cancelled"},
    user(T3, "Try a shorter summary", "c1c1c1c1-0000-4000-8000-0000000000c4", 16),
    assistant(T3, 0, "Working on a shorter", 17),
    user(T4, "Then list three next steps", "c1c1c1c1-0000-4000-8000-0000000000c5", 18, queued=True),
]
write_json("rows-page.json", {
    "rows": rows,
    "tailSeq": 57,
    "epoch": EPOCH,
    "running": {"turnId": T3, "startedAt": at(16), "rowId": f"{T3}:a0", "partialText": "Working on a shorter",
                "activity": {"kind": "tool", "tool": "web_search", "detail": "Searching the web"}},
    "queued": [{"clientId": "c1c1c1c1-0000-4000-8000-0000000000c5", "text": "Then list three next steps"}],
    "openQuestion": None,
    "nextBefore": "compaction:e-0042",
})
write_json("rows-page-older.json", {
    "rows": [
        user("7a1e0001-0000-4000-8000-00000000a000", "Hello", "c1c1c1c1-0000-4000-8000-0000000000c0", 0),
        assistant("7a1e0001-0000-4000-8000-00000000a000", 0, "Hi. What should we do first?", 1),
    ],
    "nextBefore": None,
})

# events-turn.ndjson
s = Stream()
s.ready(0, False)
s.emit("turn.started", T1, origin="owner", clientId=C1)
s.emit("message.user", T1, rowId=f"{T1}:u", clientId=C1, text="Find two sources on Pi and draw the flow",
       attachments=[{"name": "notes.txt", "mediaType": "text/plain", "size": 812}])
s.emit("activity", T1, kind="thinking")
s.emit("activity", T1, kind="tool", tool="web_search", detail="Searching the web")
s.emit("tool.call", T1, callId="call-search-1", name="web_search")
s.emit("tool.result", T1, callId="call-search-1", name="web_search", isError=False, searchResults=SEARCH)
s.emit("message.delta", T1, rowId=f"{T1}:a0", delta="Here are ")
s.emit("message.delta", T1, rowId=f"{T1}:a0", delta="two sources.")
s.emit("message.final", T1, rowId=f"{T1}:a0", text="Here are two sources.")
s.emit("activity", T1, kind="tool", tool="excalidraw__create_view", detail="Excalidraw")
s.emit("tool.call", T1, callId="call-excal-1", name="excalidraw__create_view",
       widget={"connectionId": "excalidraw", "toolName": "create_view",
               "arguments": {"elements": [{"type": "rectangle", "x": 0, "y": 0}]}})
s.emit("tool.result", T1, callId="call-excal-1", name="excalidraw__create_view", isError=False)
s.emit("row", T1, row=WIDGET_ROW)
s.emit("activity", T1, kind="tool", tool="generate_image", detail="Drawing an image")
s.emit("tool.call", T1, callId="call-img-1", name="generate_image")
s.emit("tool.result", T1, callId="call-img-1", name="generate_image", isError=False)
s.emit("row", T1, row=IMAGE_ROW)
s.emit("message.delta", T1, rowId=f"{T1}:a1", delta="I drew the flow and saved a page.")
s.emit("message.final", T1, rowId=f"{T1}:a1", text="I drew the flow and saved a page.")
s.emit("tool.call", T1, callId="call-ask-1", name="ask")
s.emit("input.requested", T1, requestId=Q1, kind="question", prompt=QUESTION["prompt"],
       options=QUESTION["options"], allowFreeform=True)
s.emit("tool.result", T1, callId="call-ask-1", name="ask", isError=False)
s.emit("turn.completed", T1)
s.ping()
s.emit("input.resolved", T2, requestId=Q1)
s.emit("turn.started", T2, origin="owner", clientId=C2)
s.emit("message.user", T2, rowId=f"{T2}:u", clientId=C2, text="Desktop", attachments=[])
s.emit("message.delta", T2, rowId=f"{T2}:a0", delta="Saved to the Desktop.")
s.emit("message.final", T2, rowId=f"{T2}:a0", text="Saved to the Desktop.")
s.emit("turn.completed", T2)
s.write("events-turn.ndjson")

# events-failure.ndjson
s = Stream(seq=30)
s.ready(30, False)
s.emit("turn.started", T2, origin="owner", clientId=C2)
s.emit("message.user", T2, rowId=f"{T2}:u", clientId=C2, text="Desktop", attachments=[])
s.emit("activity", T2, kind="retrying", detail="Retrying")
failure_row = {"rowId": f"{T2}:f", "kind": "failure", "turnId": T2, "at": at(4), "code": "upstream_unavailable",
               "detail": "The provider didn't answer.", "retryAfterMs": 4000, "messageKept": True}
s.emit("row", T2, row=failure_row)
s.emit("turn.failed", T2, code="upstream_unavailable", detail="The provider didn't answer.",
       retryAfterMs=4000, messageKept=True, rowId=f"{T2}:f")
s.ping()
# Retry: the same clientId, a new turn. The failed attempt's rows (owner bubble, failure row) are gone
# from the engine's rows page, so resync=True tells the app to refetch it.
s.emit("turn.started", T3, origin="owner", clientId=C2, retry=True, resync=True)
s.emit("message.user", T3, rowId=f"{T3}:u", clientId=C2, text="Desktop", attachments=[])
s.emit("message.delta", T3, rowId=f"{T3}:a0", delta="Saved to the Desktop.")
s.emit("message.final", T3, rowId=f"{T3}:a0", text="Saved to the Desktop.")
s.emit("turn.completed", T3)
s.write("events-failure.ndjson")

# events-queue.ndjson
s = Stream(seq=40)
s.ready(40, False)
s.emit("turn.started", T1, origin="owner", clientId=C1)
s.emit("message.user", T1, rowId=f"{T1}:u", clientId=C1, text="Write a long plan", attachments=[])
s.emit("message.delta", T1, rowId=f"{T1}:a0", delta="Step one")
s.emit("message.queued", T1, clientId=C2, text="Make it shorter")
s.emit("message.queued", T1, clientId=C3, text="and email it to me")
s.emit("message.final", T1, rowId=f"{T1}:a0", text="Step one, step two.")
s.emit("turn.completed", T1)
s.emit("turn.started", T2, origin="owner", clientId=C2)
s.emit("message.user", T2, rowId=f"{T2}:u", clientId=C2, text="Make it shorter", attachments=[])
s.emit("message.delta", T2, rowId=f"{T2}:a0", delta="Shorter")
# Cancel: every queued message is dropped first, then the running turn settles cancelled.
unsent = {"rowId": "unsent:" + C3, "kind": "unsent", "turnId": None, "at": at(11), "clientId": C3,
          "text": "and email it to me", "reason": "cancelled"}
s.emit("row", None, row=unsent)
s.emit("message.dropped", None, clientId=C3)
s.emit("message.final", T2, rowId=f"{T2}:a0", text="Shorter")
s.emit("turn.cancelled", T2)
s.write("events-queue.ndjson")

# events-compaction.ndjson
s = Stream(seq=60)
s.ready(60, False)
s.emit("turn.started", T4, origin="owner", clientId="c1c1c1c1-0000-4000-8000-0000000000c6")
s.emit("message.user", T4, rowId=f"{T4}:u", clientId="c1c1c1c1-0000-4000-8000-0000000000c6",
       text="Keep going with the report", attachments=[])
s.emit("activity", T4, kind="compacting", detail="Compacting the conversation")
note = {"rowId": "compaction:e-0099", "kind": "note", "turnId": None, "at": at(4),
        "text": "Conversation compacted to fit the model's window", "source": "compaction"}
s.emit("row", T4, row=note)
s.emit("compaction.done", T4, rowId="compaction:e-0099")
s.emit("message.delta", T4, rowId=f"{T4}:a0", delta="Continuing.")
s.emit("message.final", T4, rowId=f"{T4}:a0", text="Continuing.")
s.emit("turn.completed", T4)
s.write("events-compaction.ndjson")

# events-resync.ndjson: after=3 is older than the 2,000-event ring (tail 2,410)
s = Stream(seq=2410)
s.ready(2410, True, running={"turnId": T1})
s.emit("message.delta", T1, rowId=f"{T1}:a3", delta=" more text")
s.write("events-resync.ndjson")

# routine chat: a routine turn has no message.user; a note row precedes it
s = Stream(chat=ROUTINE_CHAT)
s.ready(0, False)
# The note is filed when the run's own turn starts, so it carries that turn's id.
routine_note = {"rowId": "note:routine-run-r1-0001", "kind": "note", "turnId": T1, "at": at(1),
                "text": "Routine Morning summary ran.", "source": "routine"}
s.emit("row", T1, row=routine_note)
s.emit("turn.started", T1, origin="routine")
s.emit("message.delta", T1, rowId=f"{T1}:a0", delta="Good morning. Three things today.")
s.emit("message.final", T1, rowId=f"{T1}:a0", text="Good morning. Three things today.")
s.emit("turn.completed", T1)
s.write("events-routine.ndjson")

# events-auto-retry.ndjson: the stream was cut mid-answer and Pi retried by itself. The app had
# already streamed the partial answer as a row; row.removed drops it, and the answer that follows
# streams under the next row id.
s = Stream(seq=60)
s.ready(60, False)
s.emit("turn.started", T1, origin="owner", clientId=C1)
s.emit("message.user", T1, rowId=f"{T1}:u", clientId=C1, text="Tell me", attachments=[])
s.emit("activity", T1, kind="thinking")
s.emit("message.delta", T1, rowId=f"{T1}:a0", delta="Half an ans")
s.emit("message.final", T1, rowId=f"{T1}:a0", text="Half an ans")
s.emit("activity", T1, kind="retrying", detail="Retrying")
s.emit("row.removed", T1, rowId=f"{T1}:a0")
s.emit("message.delta", T1, rowId=f"{T1}:a1", delta="The whole answer.")
s.emit("message.final", T1, rowId=f"{T1}:a1", text="The whole answer.")
s.emit("turn.completed", T1)
s.write("events-auto-retry.ndjson")

write_json("engine-status.json", {
    "epoch": EPOCH,
    "chats": [
        {"chatId": CHAT, "running": {"turnId": T3, "activity": {"kind": "tool", "tool": "bash", "detail": "Running a command"}},
         "waitingOnOwner": "approval", "replyReadySince": None, "lastTurn": {"turnId": T2, "outcome": "failed", "endedAt": at(14)}},
        {"chatId": ROUTINE_CHAT, "running": None, "waitingOnOwner": None, "replyReadySince": at(6),
         "lastTurn": {"turnId": T1, "outcome": "completed", "endedAt": at(6)}},
    ],
})
write_json("chats-list.json", {
    "current": CHAT,
    "chats": [
        {"chatId": CHAT, "title": "Find two sources on Pi and draw the flow", "preview": "Working on a shorter",
         "routineId": None, "updatedAt": at(18)},
        {"chatId": ROUTINE_CHAT, "title": "Morning summary", "preview": "Good morning. Three things today.",
         "routineId": "r1", "updatedAt": at(6)},
    ],
    "nextBefore": None,
})
write_json("chats-search.json", {
    "hits": [
        {"chatId": CHAT, "rowId": f"{T1}:a0", "title": "Find two sources on Pi and draw the flow",
         "snippet": "Here are two sources.", "at": at(6)},
    ],
})
print("ok")
