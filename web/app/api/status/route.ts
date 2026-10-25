import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { appVersion, systemOperator } from "../../../../shared/operator.ts";
import { engineHealthy } from "../../../../shared/engine-client.ts";
import { stackName } from "../../../../shared/stack.ts";

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const session = gate.session;
  const engine = (await engineHealthy()) ? "available" : "limited";
  return NextResponse.json({
    ok: true,
    stack: stackName(),
    apiVersion: 1,
    profile: session.profile,
    engine,
    operator: systemOperator(),
    version: appVersion(),
    theme: "light",
  });
}
