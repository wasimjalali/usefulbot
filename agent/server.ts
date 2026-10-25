import { ServiceError, startService } from "./engine/service.ts";

/**
 * The engine service (SPEC 5.1): `node --experimental-strip-types agent/server.ts`,
 * started by `scripts/service.mjs engine` with an explicit environment. It
 * listens on 127.0.0.1:<enginePort>, answers /health at once and every other
 * route with 503 `engine_starting` until boot has finished. The work is in
 * agent/engine/service.ts; this file is the process around it.
 */

function die(code: number, payload: Record<string, unknown>): never {
  process.stderr.write(`${JSON.stringify({ service: "engine", ...payload })}\n`);
  process.exit(code);
}

let service: Awaited<ReturnType<typeof startService>>;
try {
  service = await startService();
} catch (error) {
  if (error instanceof ServiceError) die(error.exitCode, error.payload);
  die(1, { error: "boot_failed", detail: error instanceof Error ? error.message : String(error) });
}
process.stdout.write(`${JSON.stringify({ service: "engine", event: "listening", port: service.port, epoch: service.engine.epoch })}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Exit within 10 s whatever is still running (SPEC 5.1).
  setTimeout(() => process.exit(1), 10_000).unref();
  await service.stop().catch((error: unknown) => {
    // Still exit (the supervisor is waiting), but say why shutdown was not clean.
    process.stderr.write(`${JSON.stringify({ service: "engine", event: "stop_failed", detail: error instanceof Error ? (error.stack ?? error.message) : String(error) })}\n`);
  });
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
