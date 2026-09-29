import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { appendAgentEvent, listThreadEvents } from "../../../../../shared/agent-store.ts";
import { findConnectionById } from "../../../../../shared/connections-store.ts";
import {
  parseWidgetDraft,
  widgetPayloadTooLarge,
  WIDGETS_PER_THREAD_MAX,
} from "../../../../../shared/mcp-apps.ts";
import { readShell } from "../../../../../shared/shell-io.ts";
import { writeWidget, type WidgetRecord } from "../../../../../shared/widgets-store.ts";
import { saveWidgetDrawing } from "../../../../lib/media-migrate";

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`widget:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = await readJson(request) as {
      botId?: string;
      callId?: string;
      data?: unknown;
      result?: unknown;
    };
    const draft = parseWidgetDraft(body.data);
    if (!draft || typeof body.botId !== "string" || typeof body.callId !== "string") {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const bot = readShell().bots.find((row) => row.id === body.botId);
    if (!bot) {
      return NextResponse.json({ ok: false, error: "bot_missing" }, { status: 400 });
    }
    if (!findConnectionById(draft.connectionId)) {
      return NextResponse.json({ ok: false, error: "widget_connection" }, { status: 400 });
    }
    if (widgetPayloadTooLarge(draft.arguments, body.result ?? null)) {
      return NextResponse.json({ ok: false, error: "widget_too_large" }, { status: 400 });
    }
    const widgets = listThreadEvents(body.botId).filter((event) => event.kind === "widget").length;
    if (widgets >= WIDGETS_PER_THREAD_MAX) {
      return NextResponse.json({ ok: false, error: "widget_limit" }, { status: 400 });
    }
    const record: WidgetRecord = {
      id: body.callId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      connectionId: draft.connectionId,
      toolName: draft.toolName,
      resourceUri: draft.resourceUri,
      arguments: draft.arguments,
      result: body.result ?? null,
      createdAt: new Date().toISOString(),
    };
    if (record.id.length < 8) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    // The app posts a drawing again whenever a chat replays it; the event it
    // already has says when it was first drawn.
    const drawnAt = listThreadEvents(body.botId).find((event) => event.widgetId === record.id)?.at;
    writeWidget(record);
    // A drawing is also the owner's file: an Excalidraw scene lands in the
    // media folder and the Library. A failed save leaves the card in the
    // chat and says why in the log; the next Library load tries again.
    try {
      saveWidgetDrawing(record, body.botId, bot.name, drawnAt);
    } catch (err) {
      console.error(`[media] could not save drawing ${record.id}`, err);
    }
    appendAgentEvent(body.botId, {
      kind: "widget",
      text: "Drawing",
      widgetId: record.id,
      id: `wgt_${record.id}`,
    });
    return NextResponse.json({ ok: true, id: record.id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "widget_failed") }, { status: 400 });
  }
}
