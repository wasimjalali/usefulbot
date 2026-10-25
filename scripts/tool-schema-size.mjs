#!/usr/bin/env node
// Weighs the 16 declared tools the way the wire sees them: the description plus
// the JSON schema each tool declares. Reports per-tool and total characters and
// description words. Compare two runs with --diff <before.txt>.
// usage: node --experimental-strip-types scripts/tool-schema-size.mjs [--diff before.txt]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

async function declared() {
  const { allTools } = await import(join(ROOT, "agent/tools/index.ts"));
  return allTools();
}

export async function measureTools() {
  const rows = [];
  for (const tool of await declared()) {
    const description = String(tool.description ?? "");
    const schema = JSON.stringify(tool.parameters);
    rows.push({
      name: tool.name,
      words: description.split(/\s+/).filter(Boolean).length,
      descChars: description.length,
      schemaChars: schema.length,
      chars: description.length + schema.length,
    });
  }
  return rows;
}

/**
 * The tools array a request carries, as OpenAI-style function entries (name,
 * description, JSON schema). Measured offline, so it leaves out the tools a
 * chat picks with find_tools. Not byte-exact against the router's view of the
 * request, which the payload probe gives; it is the number TOOL_SCHEMA_CHARS
 * (shared/admission.ts) is held against.
 */
export async function measureWire() {
  const entries = (await declared()).map((tool) =>
    JSON.stringify({ type: "function", function: { name: tool.name, description: String(tool.description ?? ""), parameters: tool.parameters } }));
  return { tools: entries.length, chars: `[${entries.join(",")}]`.length };
}

export function parseTable(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    if (line === "") break;
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
    if (match && match[1] !== "TOTAL") out.set(match[1], Number(match[5]));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = await measureTools();
  const diffAt = process.argv.indexOf("--diff");
  const before = diffAt > 0 ? parseTable(readFileSync(process.argv[diffAt + 1], "utf8")) : null;
  const pad = (value, width) => String(value).padStart(width);
  console.log(`${"tool".padEnd(22)}${pad("words", 7)}${pad("desc", 8)}${pad("schema", 8)}${pad("total", 8)}${before ? pad("delta", 8) : ""}`);
  for (const row of [...rows].sort((a, b) => b.chars - a.chars)) {
    const delta = before ? pad(row.chars - (before.get(row.name) ?? 0), 8) : "";
    console.log(`${row.name.padEnd(22)}${pad(row.words, 7)}${pad(row.descChars, 8)}${pad(row.schemaChars, 8)}${pad(row.chars, 8)}${delta}`);
  }
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const beforeTotal = before ? [...before.values()].reduce((a, b) => a + b, 0) : 0;
  console.log(`${"TOTAL".padEnd(22)}${pad(sum("words"), 7)}${pad(sum("descChars"), 8)}${pad(sum("schemaChars"), 8)}${pad(sum("chars"), 8)}${before ? pad(sum("chars") - beforeTotal, 8) : ""}`);
  console.log(`tools: ${rows.length}`);
  const wire = await measureWire();
  console.log(`tools array on the wire (function entries, without picked tools): ${wire.chars} characters, ${wire.tools} tools`);
}
