#!/usr/bin/env node
// Weighs the authored tools the way the wire sees them: the description plus the
// JSON schema zod emits for the input. Reports per-tool and total characters and
// description words. Compare two runs with --diff <before.txt>.
// usage: node --experimental-strip-types scripts/tool-schema-size.mjs [--diff before.txt]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const TOOLS = join(ROOT, "agent/tools");

export async function measureTools() {
  const rows = [];
  for (const file of readdirSync(TOOLS).filter((name) => name.endsWith(".ts")).sort()) {
    const mod = await import(join(TOOLS, file));
    const tool = mod.default;
    if (!tool?.inputSchema) continue;
    const description = String(tool.description ?? "");
    const schema = JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" }));
    rows.push({
      name: file.slice(0, -3),
      words: description.split(/\s+/).filter(Boolean).length,
      descChars: description.length,
      schemaChars: schema.length,
      chars: description.length + schema.length,
    });
  }
  return rows;
}

// eve's own default tools, measured from its definitions (what a turn carries
// when nothing under agent/tools/ replaces them). connection_search is a dynamic
// tool whose schemas eve builds at run time, so it cannot be weighed here.
// agent and task_cancel are eve's sub-agent tools, on in this app.
export const EVE_DEFAULTS = ["todo", "ask_question", "load_skill", "agent", "task_cancel"];

export async function measureEveDefaults() {
  const rows = [];
  for (const name of EVE_DEFAULTS) {
    const tool = (await import(`eve/tools/${name}`)).default;
    const description = String(tool.description ?? "");
    const schema = JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" }));
    rows.push({ name, words: description.split(/\s+/).filter(Boolean).length, descChars: description.length, schemaChars: schema.length, chars: description.length + schema.length });
  }
  return rows;
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
  // The eve defaults as eve ships them, and what the app mounts of them now.
  const eve = await measureEveDefaults();
  console.log("\neve defaults as shipped (the app replaces any with a same-name file under agent/tools)");
  for (const row of eve) console.log(`${row.name.padEnd(22)}${pad(row.words, 7)}${pad(row.descChars, 8)}${pad(row.schemaChars, 8)}${pad(row.chars, 8)}`);
  const authored = new Set(rows.map((row) => row.name));
  const mounted = eve.filter((row) => !authored.has(row.name));
  const grand = sum("chars") + mounted.reduce((total, row) => total + row.chars, 0);
  console.log(`eve defaults not overridden: ${mounted.map((row) => row.name).join(", ") || "none"}`);
  console.log(`GRAND TOTAL (authored + eve defaults not overridden): ${grand}`);
}
