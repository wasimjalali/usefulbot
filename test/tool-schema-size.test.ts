import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

// UB-009 PR C: the tool schemas are the biggest fixed cost per turn.
test("every authored tool stays short and names its siblings in snake_case", async () => {
  const { join } = await import("node:path");
  const { measureTools } = (await import(join(import.meta.dirname, "../scripts/tool-schema-size.mjs"))) as {
    measureTools: () => Promise<{ name: string; words: number; chars: number }[]>;
  };
  const rows = await measureTools();
  assert.ok(rows.length >= 30, `only ${rows.length} tools measured; the walk is broken`);
  const total = rows.reduce((sum, row) => sum + row.chars, 0);
  assert.ok(total < 20_200, `authored tools weigh ${total} chars, past the 20,200 ceiling (19,193 after PR C plus about 5%, was 20,309 before)`);
  for (const row of rows) {
    assert.ok(row.words <= 120, `${row.name} description is ${row.words} words; the ceiling is 120`);
  }
});

test("no tool description, hint or error names a tool in camelCase", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname, "../agent/tools");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  // The real names, derived from the file names: list_bots -> listBots.
  const camel = files
    .map((file) => file.slice(0, -3))
    .filter((name) => name.includes("_"))
    .map((name) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()));
  const pattern = new RegExp(`\\b(${camel.join("|")})\\b`);
  for (const file of files) {
    const mod = (await import(join(dir, file))) as { default?: { description?: string } };
    assert.equal(pattern.test(mod.default?.description ?? ""), false, `${file} description names a tool in camelCase`);
    // Every string literal the model can see (hints, errors, multi-line
    // ternaries), not just lines that say hint: or error:. Code identifiers
    // outside quotes are not text the model reads.
    const source = readFileSync(join(dir, file), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    for (const literal of source.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []) {
      // A bare identifier string (a shell action type such as "deleteBot") is code, not text the model reads.
      if (!/\s/.test(literal)) continue;
      assert.equal(pattern.test(literal), false, `${file} has a string naming a tool in camelCase: ${literal}`);
    }
  }
});

test("the script prints a table with a total", () => {
  const out = execFileSync("/usr/local/bin/node", ["--experimental-strip-types", "scripts/tool-schema-size.mjs"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(out, /^TOTAL\s+\d+\s+\d+\s+\d+\s+\d+$/m);
  assert.match(out, /^bash\s+/m);
});

// An override that re-declares eve's schema must not drift from it: if eve
// tightens a field, this fails instead of our copy silently validating less.
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "description")
        .map(([key, inner]) => [key, withoutDescriptions(inner)]),
    );
  }
  return value;
}

for (const [name, eveModule] of [
  ["web_fetch", "eve/tools/web_fetch"],
  ["todo", "eve/tools/todo"],
] as const) {
  test(`${name} override keeps eve's schema apart from description text`, async () => {
    const { z } = await import("zod");
    const { join } = await import("node:path");
    const ours = (await import(join(import.meta.dirname, `../agent/tools/${name}.ts`))) as { default: { inputSchema: never } };
    const theirs = (await import(eveModule)) as { default: { inputSchema: never } };
    const a = z.toJSONSchema(ours.default.inputSchema, { io: "input" });
    const b = z.toJSONSchema(theirs.default.inputSchema, { io: "input" });
    assert.deepEqual(withoutDescriptions(a), withoutDescriptions(b));
  });
}

for (const [name, eveModule, sameExecute] of [
  ["web_fetch", "eve/tools/web_fetch", false],
  ["todo", "eve/tools/todo", true],
] as const) {
  test(`${name} override keeps eve's executor and behaviour symbols`, async () => {
    const { join } = await import("node:path");
    type Tool = { execute: unknown };
    const ours = ((await import(join(import.meta.dirname, `../agent/tools/${name}.ts`))) as { default: Tool }).default;
    const theirs = ((await import(eveModule)) as { default: Tool }).default;
    assert.equal(typeof ours.execute, "function");
    // web_fetch wraps eve's execute to fence the page text; todo spreads it as is.
    if (sameExecute) assert.equal(ours.execute, theirs.execute);
    for (const symbol of Object.getOwnPropertySymbols(theirs)) {
      assert.ok(symbol in ours, `${name} override lost eve's ${String(symbol)}`);
    }
  });
}
