import assert from "node:assert/strict";
import test from "node:test";

/**
 * The S2 fixture tool must not be in the live tool set. Round 2 found it
 * registered in production and the first fix, `disableTool()` in the same
 * slot, made eve exit at boot: the slot belongs to this repo, not to an
 * extension or a built-in default, and eve refuses it there. A dynamic tool
 * may resolve to nothing, which is what this pins.
 */
async function resolve(fixture: string | undefined): Promise<unknown> {
  const before = process.env.UB_S2_FIXTURE;
  if (fixture === undefined) delete process.env.UB_S2_FIXTURE;
  else process.env.UB_S2_FIXTURE = fixture;
  try {
    const mod = await import("../agent/tools/plant_read.ts");
    const dynamic = mod.default as {
      kind: string;
      events: Record<string, () => unknown>;
    };
    assert.equal(dynamic.kind, "eve:dynamic");
    return dynamic.events["session.started"]();
  } finally {
    if (before === undefined) delete process.env.UB_S2_FIXTURE;
    else process.env.UB_S2_FIXTURE = before;
  }
}

test("plant_read resolves to no tool in a live session", async () => {
  assert.equal(await resolve(undefined), null);
  assert.equal(await resolve("0"), null);
  assert.equal(await resolve(""), null);
});

test("plant_read is a real tool under the S2 probe's own flag", async () => {
  const tool = await resolve("1") as { description?: string } | null;
  assert.ok(tool, "the probe needs the tool it asks eve to call");
  assert.match(tool.description ?? "", /S2 planted token/);
});
