import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import net, { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ServiceError, startService } from "../../agent/engine/service.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld, fakeTools, type World } from "./helpers.ts";
import { currentChatInShell, setCurrentChatInShell, type Deps } from "../../agent/engine/deps.ts";
import { parseTurnBody } from "../../shared/turn-input.ts";

/** The service around the engine (SPEC 5.1) and contract test 11: nothing talks to the network but the router. */

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function depsFor(world: World): Deps {
  const tools = fakeTools(world.state);
  return {
    allTools: () => tools,
    pickedTools: () => [],
    refreshPickedTools: async () => undefined,
    restoreTodos: () => undefined,
    widgetForCall: () => null,
    listSkills: () => [],
    notesBlockFor: () => "",
    setRoutineChat: () => undefined,
    parseTurnBody,
    currentChat: currentChatInShell,
    setCurrentChat: setCurrentChatInShell,
  };
}

async function envFor(world: World, extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    UB_STATE_ROOT: world.root,
    UB_ENGINE_PORT: String(await freePort()),
    UB_ROUTER_PORT: String(world.router.port),
    UB_ENGINE_TOKEN: "engine-service-token",
    UB_ROUTER_DESKTOP_TOKEN: "test-router-token",
    ...extra,
  };
}

test("it refuses to start without its tokens, and says which, without printing any", async () => {
  const world = await makeWorld();
  try {
    for (const missing of ["UB_ENGINE_TOKEN", "UB_ROUTER_DESKTOP_TOKEN"]) {
      const env = await envFor(world, { [missing]: "" });
      await assert.rejects(startService({ env, deps: depsFor(world) }), (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        assert.equal(error.exitCode, 2);
        assert.deepEqual(error.payload, { error: "tokens_missing", missing: [missing] });
        return true;
      });
    }
  } finally {
    await world.close();
  }
});

test("anything already on the engine port is a refusal to start", async () => {
  const world = await makeWorld();
  const squatter = createServer();
  try {
    const env = await envFor(world);
    await new Promise<void>((resolve) => squatter.listen(Number(env.UB_ENGINE_PORT), "127.0.0.1", resolve));
    await assert.rejects(startService({ env, deps: depsFor(world) }), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.payload.error, "port_in_use");
      return true;
    });
  } finally {
    squatter.close();
    await world.close();
  }
});

test("a boot that cannot finish frees the port and says why", async () => {
  const world = await makeWorld();
  try {
    mkdirSync(join(world.root, "engine2"), { recursive: true });
    writeFileSync(join(world.root, "engine", "chats.json"), "{ not json");
    const env = await envFor(world);
    await assert.rejects(startService({ env, deps: depsFor(world) }), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.payload.error, "boot_failed");
      return true;
    });
    // The port is free again.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(Number(env.UB_ENGINE_PORT), "127.0.0.1", () => probe.close(() => resolve()));
    });
  } finally {
    await world.close();
  }
});

test("contract 11: a full turn with tools talks to the router and nothing else", async () => {
  const world = await makeWorld();
  const connections: string[] = [];
  const original = net.Socket.prototype.connect;
  let service: Awaited<ReturnType<typeof startService>> | null = null;
  try {
    const env = await envFor(world);
    service = await startService({ env, deps: depsFor(world) });
    const base = `http://127.0.0.1:${service.port}`;
    const headers = { authorization: "Bearer engine-service-token", "content-type": "application/json" };
    net.Socket.prototype.connect = function traced(this: net.Socket, ...args: unknown[]) {
      let first = args[0] as { host?: string; port?: number; path?: string } | unknown[] | number | string;
      if (Array.isArray(first)) first = first[0] as { host?: string; port?: number; path?: string };
      if (typeof first === "object" && first !== null) connections.push(first.path ? `unix:${first.path}` : `${first.host ?? "?"}:${first.port ?? "?"}`);
      else connections.push(`${String(args[1] ?? "?")}:${String(first)}`);
      return (original as (...rest: unknown[]) => net.Socket).apply(this, args);
    } as typeof original;

    const created = await (await fetch(`${base}/chats`, { method: "POST", headers, body: JSON.stringify({ botId: DEFAULT_BOT_ID }) })).json() as { chatId: string };
    world.router.enqueue(
      { kind: "tools", calls: [{ name: "web_search", args: { query: "pi" } }, { name: "echo", args: { text: "x" } }] },
      { kind: "text", text: "All done." },
    );
    await fetch(`${base}/chats/${created.chatId}/turns`, { method: "POST", headers, body: JSON.stringify({ clientId: crypto.randomUUID(), text: "go", attachments: [] }) });
    const deadline = Date.now() + 10_000;
    let rows: { rows: { kind: string }[] } = { rows: [] };
    while (Date.now() < deadline) {
      rows = await (await fetch(`${base}/chats/${created.chatId}/rows`, { headers })).json() as typeof rows;
      if (rows.rows.some((row) => row.kind === "assistant") && !(service.engine.host.chat(created.chatId).turn)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(rows.rows.some((row) => row.kind === "assistant"), "the turn finished");
    const outbound = connections.filter((target) => !target.endsWith(`:${service!.port}`));
    assert.ok(outbound.length > 0, "the trace saw the router connection");
    for (const target of outbound) assert.equal(target, `127.0.0.1:${world.router.port}`, `unexpected connection to ${target}`);
    assert.equal(process.env.PI_OFFLINE, "1");
    assert.equal(process.env.PI_TELEMETRY, "0");
  } finally {
    net.Socket.prototype.connect = original;
    await service?.stop();
    await world.close();
  }
});

test("stopping aborts a running turn and frees the port", async () => {
  const world = await makeWorld();
  try {
    const env = await envFor(world);
    const service = await startService({ env, deps: depsFor(world) });
    const chat = service.engine.createChat(DEFAULT_BOT_ID).chatId;
    world.router.enqueue({ kind: "stall", text: "working" });
    service.engine.submitTurn(chat, { clientId: crypto.randomUUID(), text: "hold", attachments: [] });
    const deadline = Date.now() + 3_000;
    while (world.router.requests.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    const stopping = service.stop();
    // The listener is closed before the turns are: a request during the stop is refused at the door, not run.
    await assert.rejects(fetch(`http://127.0.0.1:${env.UB_ENGINE_PORT}/health`), "nothing is accepted once stop has begun");
    await stopping;
    assert.ok(Date.now() - started < 5_000, "stop is quick");
    assert.equal(service.engine.host.chat(chat).turn, null);
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(Number(env.UB_ENGINE_PORT), "127.0.0.1", () => probe.close(() => resolve()));
    });
  } finally {
    await world.close();
  }
});
