import { resolve } from "node:path";
import type { NextConfig } from "next";

// The Next app lives in web/ but every route imports shared code from the
// repository root (shared/, agent/, router/). Both dev and build run from the
// repository root, so ".." would resolve one level above it; derive the root
// from this file instead. __dirname exists when Next transpiles the config,
// process.cwd() covers the native TypeScript loader.
const repoRoot = typeof __dirname === "string" ? resolve(__dirname, "..") : process.cwd();

const nextConfig: NextConfig = {
  output: "standalone",
  // Root `tsc --noEmit` is the type gate. Next's in-app tsc looks for
  // typescript under web/ and fails this monorepo layout.
  typescript: { ignoreBuildErrors: true },
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // The sign-in callback's query holds the authorization code and state, so
  // Next's request log never prints it. The pattern is tested against
  // request.url: the path with its query string (node_modules/next/dist/
  // server/dev/log-requests.js).
  logging: { incomingRequests: { ignore: [/^\/auth\/callback(?:[?#]|$)/] } },
};

export default nextConfig;
