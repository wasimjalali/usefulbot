import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { safeId } from "../../../../lib/engine-proxy";
import { EngineUnavailableError, engineWidgetRow } from "../../../../../shared/engine-client.ts";
import { findConnectionById } from "../../../../../shared/connections-store.ts";
import {
  parseWidgetDraft,
  widgetPayloadTooLarge,
  WIDGETS_PER_THREAD_MAX,
} from "../../../../../shared/mcp-apps.ts";
import { readShell } from "../../../../../shared/shell-io.ts";
import { listWidgets, readWidget, writeWidget, type WidgetRecord } from "../../../../../shared/widgets-store.ts";
import { saveWidgetDrawing } from "../../../../lib/widget-drawing";

/**
 * The app posts an MCP-app widget (an Excalidraw scene) back once the model's
 * tool call drew it. The record is stored, a drawing is filed in the Library
 * and the engine appends the widget row to the chat that drew it (SPEC 5.10),
 * after which the app swaps its live widget for the row. The app posts again
 * whenever it replays the widget; every step is idempotent.
 */
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
      chatId?: string;
      callId?: string;
      data?: unknown;
      result?: unknown;
    };
    const draft = parseWidgetDraft(body.data);
    const botId = safeId(body.botId);
    const chatId = safeId(body.chatId);
    if (!draft || !botId || !chatId || typeof body.callId !== "string" || body.callId.length > 200) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const bot = readShell().bots.find((row) => row.id === botId);
    if (!bot) {
      return NextResponse.json({ ok: false, error: "bot_missing" }, { status: 400 });
    }
    if (!findConnectionById(draft.connectionId)) {
      return NextResponse.json({ ok: false, error: "widget_connection" }, { status: 400 });
    }
    if (widgetPayloadTooLarge(draft.arguments, body.result ?? null)) {
      return NextResponse.json({ ok: false, error: "widget_too_large" }, { status: 400 });
    }
    const id = body.callId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (id.length < 8) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const first = readWidget(id);
    if (!first && listWidgets().filter((record) => record.chatId === chatId).length >= WIDGETS_PER_THREAD_MAX) {
      return NextResponse.json({ ok: false, error: "widget_limit" }, { status: 400 });
    }
    const record: WidgetRecord = {
      id,
      chatId,
      connectionId: draft.connectionId,
      toolName: draft.toolName,
      resourceUri: draft.resourceUri,
      arguments: draft.arguments,
      result: body.result ?? null,
      // The first post says when it was first drawn.
      createdAt: first?.createdAt ?? new Date().toISOString(),
    };
    writeWidget(record);
    // A drawing is also the owner's file: an Excalidraw scene lands in the
    // media folder and the Library. A failed save leaves the card in the
    // chat and says why in the log.
    try {
      saveWidgetDrawing(record, botId, bot.name, record.createdAt);
    } catch (err) {
      console.error(`[media] could not save drawing ${record.id}`, err);
    }
    try {
      await engineWidgetRow(botId, chatId, record.id, body.callId);
    } catch (err) {
      // Not stored in the chat yet: the app posts again, and the key keeps that harmless.
      if (err instanceof EngineUnavailableError) {
        return NextResponse.json({ ok: false, error: "engine_unavailable" }, { status: 503 });
      }
      throw err;
    }
    return NextResponse.json({ ok: true, id: record.id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "widget_failed") }, { status: 400 });
  }
}
