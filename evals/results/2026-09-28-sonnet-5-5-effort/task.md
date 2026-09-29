You are in a copy of the Useful Bot repository (a macOS app plus a local Next.js web service in `web/`). Ignore `node_modules/` and `web/.next/`. Read only: do not edit, build or run servers.

The owner wants to delete the browser UI from `web/` and keep only the API service the macOS app calls. Answer, with file paths and line numbers as evidence:

1. Exactly which files in `web/` are browser UI only (safe to delete), and which must stay because the macOS app, iOS app or scripts use them.
2. Every build script, launcher, test or asset pipeline that would break or need changing if those UI files are deleted. Be specific about what fails and where.
3. Whether a packaged release (see `scripts/build-runtime.mjs`, `scripts/service.mjs`, `scripts/web-mode.mjs`) would still start its web service after the change, and whether it starts today. Reason about Node module resolution for the standalone server.
4. Which dependencies in `package.json` become unused, and what else must change if they are removed.

End with a numbered list of concrete findings.
