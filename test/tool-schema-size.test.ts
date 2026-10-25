import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

// UB-009 PR C: the tool schemas are the biggest fixed cost per turn.
test("the 16 declared tools stay short and name their siblings in snake_case", async () => {
  const { join } = await import("node:path");
  const { measureTools } = (await import(join(import.meta.dirname, "../scripts/tool-schema-size.mjs"))) as {
    measureTools: () => Promise<{ name: string; words: number; chars: number }[]>;
  };
  const rows = await measureTools();
  assert.equal(rows.length, 16, `${rows.length} tools measured; SPEC 5.8 declares 16`);
  const total = rows.reduce((sum, row) => sum + row.chars, 0);
  assert.ok(total < 15_000, `the 16 tools weigh ${total} chars, past the 15,000 ceiling of SPEC 13`);
  for (const row of rows) {
    assert.ok(row.words <= 120, `${row.name} description is ${row.words} words; the ceiling is 120`);
  }
});

test("no tool description, hint or error names a tool in camelCase", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname, "../agent/tools");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  // The real names: list_dir -> listDir.
  const { allTools } = await import("../agent/tools/index.ts");
  const camel = allTools()
    .map((tool) => tool.name)
    .filter((name) => name.includes("_"))
    .map((name) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()));
  const pattern = new RegExp(`\\b(${camel.join("|")})\\b`);
  for (const tool of allTools()) {
    assert.equal(pattern.test(tool.description), false, `${tool.name} description names a tool in camelCase`);
  }
  for (const file of files) {
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

test("the tools array as the model's request carries it fits TOOL_SCHEMA_CHARS with 15% to spare", async () => {
  const { join } = await import("node:path");
  const { measureWire } = (await import(join(import.meta.dirname, "../scripts/tool-schema-size.mjs"))) as {
    measureWire: () => Promise<{ tools: number; chars: number }>;
  };
  const { TOOL_SCHEMA_CHARS } = await import("../shared/admission.ts");
  const wire = await measureWire();
  assert.equal(wire.tools, 16);
  assert.ok(
    wire.chars <= TOOL_SCHEMA_CHARS * 0.85,
    `the tools array is ${wire.chars} characters against TOOL_SCHEMA_CHARS ${TOOL_SCHEMA_CHARS}; raise the constant in shared/admission.ts with a new measurement`,
  );
});

test("the script prints a table with a total", () => {
  const out = execFileSync("/usr/local/bin/node", ["--experimental-strip-types", "scripts/tool-schema-size.mjs"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(out, /^TOTAL\s+\d+\s+\d+\s+\d+\s+\d+$/m);
  assert.match(out, /^bash\s+/m);
  assert.match(out, /^tools: 16$/m);
});
