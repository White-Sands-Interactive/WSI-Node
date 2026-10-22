import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServer } from "@whitesands/agent-player";
import { PROTOCOL_VERSION } from "@whitesands/agent-player/protocol";
import { createScriptedModel } from "./model.js";
import { PlatformServer } from "./server.js";
import { PlatformStore } from "./store.js";

class Pawn {
  x = 0;
  see() {
    return { x: this.x };
  }
  move(dx: number) {
    this.x += dx;
    return { x: this.x };
  }
}

describe("websocket contract", () => {
  let dir = "";
  let server: PlatformServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function boot() {
    dir = await mkdtemp(path.join(tmpdir(), "wsi-contract-"));
    const store = new PlatformStore(dir);
    const key = await store.createKey("contract");
    server = new PlatformServer({
      port: 0,
      store,
      model: createScriptedModel([
        { name: "move", arguments: { dx: 4 } },
        { name: "move", arguments: { dx: 1 } },
      ]),
    });
    const address = await server.listen();
    return { key: key.key, url: `ws://${address.host}:${address.port}` };
  }

  it("rejects a client speaking a different protocol version", async () => {
    const { url } = await boot();
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "hello",
          platformKey: "pk_ignored",
          clientId: "probe",
          protocolVersion: PROTOCOL_VERSION + 9,
          sdkVersion: "0.0.0",
        }));
      });
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
    });
    const envelope = JSON.parse(reply) as { type: string; code?: string };
    expect(envelope.type).toBe("hello_err");
    expect(envelope.code).toBe("PROTOCOL");
  });

  it("plays a turn over the socket and resumes after the socket drops", async () => {
    const { key, url } = await boot();
    const pawn = new Pawn();
    let disconnected = false;
    let reconnected = false;
    const agents = new AgentServer({
      platformKey: key,
      platformUrl: url,
      onEvent: (event) => {
        if (event.type === "disconnected") disconnected = true;
        if (event.type === "reconnected") reconnected = true;
      },
    });
    const agent = await agents.start(pawn, { goal: "Step forward" });
    const first = await agent.turn({ timeoutMs: 5_000 });
    expect(first.action).toBe("move");
    expect(pawn.x).toBe(4);
    server!.dropConnections();
    await waitFor(() => disconnected && reconnected);
    const result = await agent.turn({ timeoutMs: 5_000 });
    expect(result.action).toBe("move");
    expect(pawn.x).toBe(5);
    await agents.close();
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 5_000) throw new Error("timed out waiting for reconnect");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
