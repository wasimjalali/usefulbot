import { NextResponse } from "next/server";

// The browser UI was removed on 2026-09-28: this service is the API the Mac
// app calls. `/` only says the service is up, and carries no data.
export function GET() {
  return NextResponse.json({ ok: true, service: "useful-bot-web" });
}
