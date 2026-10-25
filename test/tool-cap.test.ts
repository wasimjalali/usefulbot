import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "../agent/tools/index.ts";
import {
  MAX_SESSION_TOOLS,
  MAX_SESSION_TOOL_BYTES,
  MAX_TOOL_SCHEMAS,
  MAX_TOOL_SCHEMA_BYTES,
} from "../shared/policy.ts";

/**
 * Room for a few more declared tools. The point is that one added tool trips
 * this test in CI, never a live turn at the router.
 */
const SESSION_TOOL_HEADROOM = 16;

/** What the 16 declared tools weigh on the wire: each function entry, JSON-encoded. */
function declaredBytes(): number {
  return allTools().reduce((total, tool) => total + Buffer.byteLength(
    JSON.stringify({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }),
    "utf8",
  ), 0);
}

test("the declared tools and a chat's picks fit under the router's schema cap with headroom", () => {
  // On 2026-09-15 the 26th authored tool took the total to 33 against a cap
  // of 32, and every turn died at the router with `unsupported_parameter`
  // before the model was called. The picks a chat may hold are capped by
  // MAX_SESSION_TOOLS, so the arithmetic that says it is enough is checked
  // here rather than asserted in a comment.
  const count = allTools().length;
  assert.equal(count, 16);
  const worst = count + MAX_SESSION_TOOLS + SESSION_TOOL_HEADROOM;
  assert.ok(
    worst <= MAX_TOOL_SCHEMAS,
    `${count} declared tool schemas plus MAX_SESSION_TOOLS=${MAX_SESSION_TOOLS} and ${SESSION_TOOL_HEADROOM} headroom is ${worst}, past MAX_TOOL_SCHEMAS=${MAX_TOOL_SCHEMAS}. Lower a budget in shared/policy.ts`,
  );
});

test("the tool budgets fit under the router's byte cap too", () => {
  // The router refuses on bytes as well as on count, with the same
  // non-retryable error.
  const declared = declaredBytes();
  assert.ok(declared > 8_000, `only measured ${declared} bytes of declared tool schema; the walk is broken`);
  const worst = MAX_SESSION_TOOL_BYTES + declared;
  assert.ok(
    worst <= MAX_TOOL_SCHEMA_BYTES,
    `MAX_SESSION_TOOL_BYTES=${MAX_SESSION_TOOL_BYTES} plus ${declared} measured for the declared tools is ${worst}, past MAX_TOOL_SCHEMA_BYTES=${MAX_TOOL_SCHEMA_BYTES}. Lower a budget in shared/policy.ts`,
  );
});
