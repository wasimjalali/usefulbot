import { NextResponse } from "next/server";
import { stackName } from "../../../../shared/stack.ts";

export async function GET() {
  return NextResponse.json({ ok: true, stack: stackName() });
}
