import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";

export const runtime = "nodejs";

const REVIEWER_SESSION_ID = randomUUID();
const REVIEWER_TURN_ID = randomUUID();

function fixtureReview(text: string): string {
  const clipped = text.trim().slice(0, 80) || "(empty)";
  return [
    "Reviewer (fixture, no live glm-5.3 on this host).",
    `Supplied text starts: ${clipped}`,
    "High: none found without a live reviewer model.",
    "Advisory only. This is not an owner security signoff.",
  ].join("\n");
}

async function liveReview(text: string, token: string): Promise<string> {
  // UB_ROUTER_BASE_URL is a base ending in /v1, the way agent/agent.ts reads
  // it; the chat path is appended here rather than baked into the default.
  const base = process.env.UB_ROUTER_BASE_URL ?? "http://127.0.0.1:4319/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-useful-session-id": REVIEWER_SESSION_ID,
      "x-useful-turn-id": REVIEWER_TURN_ID,
      "x-useful-request-id": randomUUID(),
    },
    body: JSON.stringify({
      model: "reviewer",
      messages: [{ role: "user", content: text }],
      max_tokens: 1024,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`reviewer_failed:${res.status}`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content?.trim() || "Reviewer returned no text.";
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`reviewer:${gate.session.callerId}`, 20)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: { text?: unknown };
  try {
    body = await readJson(request) as { text?: unknown };
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const text = body.text.trim().slice(0, 8000);
  const token = process.env.UB_ROUTER_REVIEWER_TOKEN;
  try {
    if (!token) {
      return NextResponse.json({ ok: true, fixture: true, text: fixtureReview(text) });
    }
    const review = await liveReview(text, token);
    return NextResponse.json({ ok: true, fixture: false, text: review });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "reviewer_failed") }, { status: 502 });
  }
}
