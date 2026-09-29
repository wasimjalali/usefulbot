import { homedir } from "node:os";
import { join } from "node:path";
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { selectSandbox } from "../../shared/sandbox.ts";
import { loadRuntimeConfig } from "../../shared/runtime.ts";

// The pin in the owner's runtime config is the source of truth, and the path
// is resolved the way the router does it: UB_ROUTER_CONFIG, else
// ~/.useful-bot/config.json. An unreadable config keeps the old binary
// sniffing behaviour below.
let pin: string | null = null;
try {
  pin = loadRuntimeConfig(
    process.env.UB_ROUTER_CONFIG ?? join(homedir(), ".useful-bot/config.json"),
  ).sandbox.backend;
} catch {
  // No readable config: fall back to sniffing, as before.
}
const decision = selectSandbox(pin ?? undefined);
if (decision.backend !== "just-bash") {
  throw new Error(
    `sandbox backend ${decision.backend} is present but S3 has not certified a VM; refuse silent upgrade`,
  );
}
// A pinned VM backend that is not ready must not fall through to just-bash
// either: a pin failing readiness disables execution.
if (pin !== null && pin !== "just-bash") {
  throw new Error(
    `sandbox backend ${pin} is pinned but not ready; refuse silent fallthrough to just-bash`,
  );
}

export default defineSandbox({
  backend: justbash({ autoInstall: false }),
});
