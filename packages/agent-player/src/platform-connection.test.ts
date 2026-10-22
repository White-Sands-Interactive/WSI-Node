import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentServer } from "./agent-server.js";
import { PlatformAuthError, ProtocolVersionError } from "./errors.js";
import { PROTOCOL_VERSION, type Envelope } from "./protocol.js";

type FakePlatform = {
  url: string;
  received: Envelope[];
  sockets: WebSocket[];
  send: (envelope: Envelope) => void;
  close: () => Promise<void>;
};

/** Speaks the connection-level protocol only; turns are answered by the test. */
async function fakePlatform(helloErr?: { code: "AUTH" | "PROTOCOL"; message: string }): Promise<FakePlatform> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const received: Envelope[] = [];
  const sockets: WebSocket[] = [];

  wss.on("connection", (ws) => {
    sockets.push(ws);
    const reply = (envelope: Envelope) => ws.send(JSON.stringify(envelope));
    ws.on("message", (raw) => {
      const envelope = JSON.parse(raw.toString()) as Envelope;
      received.push(envelope);
      switch (envelope.type) {
        case "hello":
          if (helloErr) reply({ type: "hello_err", ...helloErr });
          else reply({ type: "hello_ok", accountName: "fake", protocolVersion: PROTOCOL_VERSION });
          return;
        case "start_session":
          reply({ type: "session_started", sessionId: envelope.sessionId });
          return;
        case "resume_session":
          reply({ type: "session_resumed", sessionId: envelope.sessionId });
          return;
        case "stop_session":
          reply({ type: "session_stopped", sessionId: envelope.sessionId });
          return;
        case "ping":
          reply({ type: "pong", id: envelope.id });
          return;
        default:
          return;
      }
    });
  });

  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    sockets,
    send: (envelope) => sockets.at(-1)?.send(JSON.stringify(envelope)),
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

class Pawn {
  see() {
    return {};
  }
  move(dx: number) {
    return { dx };
  }
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 5_000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("platform connection", () => {
  let platform: FakePlatform | null = null;

  afterEach(async () => {
    await platform?.close();
    platform = null;
  });

  it("sends the protocol version and maps hello_err codes to typed errors", async () => {
    platform = await fakePlatform({ code: "PROTOCOL", message: "upgrade" });
    const outdated = new AgentServer({ platformKey: "pk_test", platformUrl: platform.url });
    await expect(outdated.start(new Pawn())).rejects.toBeInstanceOf(ProtocolVersionError);
    expect(platform.received[0]).toMatchObject({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await platform.close();

    platform = await fakePlatform({ code: "AUTH", message: "bad key" });
    const unauthorized = new AgentServer({ platformKey: "pk_wrong", platformUrl: platform.url });
    await expect(unauthorized.start(new Pawn())).rejects.toBeInstanceOf(PlatformAuthError);
  });

  it("reconnects, resumes with the session token, and finishes the turn on the new socket", async () => {
    platform = await fakePlatform();
    const events: string[] = [];
    const agents = new AgentServer({
      platformKey: "pk_test",
      platformUrl: platform.url,
      onEvent: (event) => events.push(event.type),
    });
    const agent = await agents.start(new Pawn(), { goal: "Step" });
    const started = platform.received.find((envelope) => envelope.type === "start_session");
    if (started?.type !== "start_session") throw new Error("no start_session");
    expect(started.goal).toBe("Step");

    platform.sockets[0]!.terminate();
    await waitFor(() => events.includes("reconnected"));
    expect(events).toContain("disconnected");
    expect(platform.sockets).toHaveLength(2);
    expect(platform.received).toContainEqual({
      type: "resume_session",
      sessionId: started.sessionId,
      sessionToken: started.sessionToken,
    });

    const turn = agent.turn({ timeoutMs: 5_000 });
    platform.send({
      type: "turn_result",
      sessionId: agent.sessionId,
      ok: true,
      action: "move",
      args: { dx: 1 },
      result: { dx: 1 },
      attempts: 1,
      usage: { promptTokens: 3, completionTokens: 2 },
    });
    await expect(turn).resolves.toEqual({
      action: "move",
      args: { dx: 1 },
      result: { dx: 1 },
      attempts: 1,
      usage: { promptTokens: 3, completionTokens: 2 },
    });
    await agents.close();
  });
});
