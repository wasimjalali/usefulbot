#!/usr/bin/env node
// eve marks a message it sends into a session on a background task's behalf
// (a sub-agent's result, a background tool's message) as
// `execution.background_task`, then drops the mark on the `message.received`
// it streams. Without it the app can only tell such a message from the
// owner's by eve's wording, and a background tool's own message has none.
// This forwards the mark as `data.kind`. Runs on every npm install and ci
// (postinstall), and fails loud when eve's code no longer matches.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVE = path.join(ROOT, "node_modules/eve");
const VERSION = "0.54.3";

const PATCHES = [
  {
    file: "dist/src/harness/emission.js",
    from: "createMessageReceivedEvent({message:t.message,sequence:n.sequence,turnId:a})",
    to: "createMessageReceivedEvent({message:t.message,sequence:n.sequence,turnId:a,kind:t.frameworkMessageKind})",
  },
  {
    file: "dist/src/protocol/message.js",
    from: "sequence:e.sequence,turnId:e.turnId},type:`message.received`}",
    to: "sequence:e.sequence,turnId:e.turnId,...(e.kind===`execution.background_task`?{kind:e.kind}:{})},type:`message.received`}",
  },
];

const version = JSON.parse(readFileSync(path.join(EVE, "package.json"), "utf8")).version;
if (version !== VERSION) {
  throw new Error(`patch-eve: written for eve ${VERSION}, found ${version}. Check whether eve now forwards the kind itself, then update or drop this patch.`);
}
for (const { file, from, to } of PATCHES) {
  const full = path.join(EVE, file);
  const source = readFileSync(full, "utf8");
  if (source.includes(to)) continue;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`patch-eve: expected one match in ${file}, found ${count}`);
  writeFileSync(full, source.replace(from, to));
  console.log(`patch-eve: patched ${file}`);
}
