import type { Server } from "node:http";
import { join } from "node:path";
import { enforceStack, enginePort, LOOPBACK, routerApiBase, stackName, stateRoot } from "../../shared/stack.ts";
import { ApprovalStore, defaultApprovalsPath } from "../lib/approvals.ts";
import { loadDeps, type Deps } from "./deps.ts";
import { Engine } from "./engine.ts";
import { createEngineServer } from "./http.ts";

/**
 * Starts the engine service (SPEC 5.1) from an environment. `agent/server.ts`
 * is the process entry; this is the part a test can run in-process. It listens
 * first, so /health answers while the rest of boot runs, and every other route
 * says `engine_starting` until the engine is up.
 */

/** A refusal to start: the exit code and the JSON line the supervisor reads. */
export class ServiceError extends Error {
  readonly exitCode: number;
  readonly payload: Record<string, unknown>;
  constructor(exitCode: number, payload: Record<string, unknown>) {
    super(String(payload.error));
    this.name = "ServiceError";
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

export type Service = {
  port: number;
  server: Server;
  engine: Engine;
  /** Aborts running turns, closes the listener and resolves when everything is down. */
  stop(): Promise<void>;
};

export async function startService(options: { env?: NodeJS.ProcessEnv; deps?: Deps } = {}): Promise<Service> {
  const env = options.env ?? process.env;
  enforceStack("engine", env);
  const engineToken = env.UB_ENGINE_TOKEN;
  const routerToken = env.UB_ROUTER_DESKTOP_TOKEN;
  if (!engineToken || !routerToken) {
    throw new ServiceError(2, {
      error: "tokens_missing",
      missing: [!engineToken ? "UB_ENGINE_TOKEN" : null, !routerToken ? "UB_ROUTER_DESKTOP_TOKEN" : null].filter(Boolean),
    });
  }
  const root = join(stateRoot(env), "engine");
  // service.mjs sets these; they are repeated so a run from a shell cannot reach for ~/.pi or the network.
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");

  const port = enginePort(env);
  let engine: Engine | null = null;
  const server = createEngineServer({ token: engineToken, port, stack: stackName(env), engine: () => engine });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new ServiceError(1, { error: error.code === "EADDRINUSE" ? "port_in_use" : "listen_failed", port }));
    });
    server.listen(port, LOOPBACK, resolve);
  });
  try {
    engine = await Engine.boot({
      engineDir: root,
      routerBaseUrl: routerApiBase(env),
      routerToken: () => routerToken,
      deps: options.deps ?? await loadDeps(),
      approvals: new ApprovalStore(Date.now, defaultApprovalsPath()),
    });
  } catch (error) {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    throw new ServiceError(1, { error: "boot_failed", detail: error instanceof Error ? error.message : String(error) });
  }
  const running = engine;
  return {
    port,
    server,
    engine: running,
    stop: async () => {
      // Stop accepting first, so nothing new arrives while the turns are being closed.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await running.close();
      await closed;
    },
  };
}
