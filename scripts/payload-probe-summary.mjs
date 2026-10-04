#!/usr/bin/env node
// Summarises the dumps UB_PAYLOAD_PROBE_DIR collects (router/src/payload-probe.ts).
// usage: node scripts/payload-probe-summary.mjs <dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: payload-probe-summary.mjs <dir>\n");
  process.exit(2);
}

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return content == null ? "" : JSON.stringify(content);
}

const one = (value, max) => text(value).slice(0, max).replace(/\s+/g, " ");

for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
  let body;
  try {
    body = JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch (error) {
    console.log(`== ${name}\nskipped: ${error.message}`);
    continue;
  }
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const roles = (m) => m?.role;
  // chat bodies carry system messages in `messages`; Messages carries `system`; Responses carries `instructions`.
  const system = [
    ...(body.system !== undefined ? (Array.isArray(body.system) ? body.system : [body.system]) : []),
    ...(typeof body.instructions === "string" ? [body.instructions] : []),
    ...messages.filter((m) => roles(m) === "system" || roles(m) === "developer").map((m) => m.content),
  ];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const firstUser = messages.find((m) => roles(m) === "user");
  console.log(`== ${name}`);
  console.log(`model: ${body.model ?? "unknown"}`);
  console.log(`system messages: ${system.length} [${system.map((s) => text(s).length).join(", ")} chars]`);
  system.forEach((s, i) => console.log(`  system[${i}]: ${one(s, 200)}`));
  console.log(`tools: ${tools.length}, schema chars: ${JSON.stringify(tools).length}`);
  console.log(`first user: ${firstUser ? one(firstUser.content, 300) : "(none)"}`);
}
