// Loaded with `node --import` by test/setup-local.test.ts only. Every import of
// node:child_process (except the stub's own) resolves to child-process.mjs, so
// scripts/setup-local.mjs runs unchanged while its /usr/bin/security calls go
// to a file-backed stand-in and never reach the login Keychain.
import { registerHooks } from "node:module";

const stub = new URL("./child-process.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === "node:child_process" || specifier === "child_process") && context.parentURL !== stub) {
      return { url: stub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
