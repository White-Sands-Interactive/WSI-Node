import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  SESSION_RESUME_GRACE_MS,
  assertNever,
  type Envelope,
} from "@whitesands/agent-player/protocol";
import { loopEventToAgentEvent, SessionLoop } from "@whitesands/agent-player/testing";
import type { ModelClient } from "./model.js";
import type { PlatformStore } from "./store.js";
import { PlatformSessionTransport } from "./ws-server-transport.js";

type ClientState = {
  ws: WebSocket;
  platformKey: string;
  accountName: string;
  dropped: boolean;
};

type LiveSession = {
  id: string;
  token: string;
  transport: PlatformSessionTransport;
  loop: SessionLoop;
  client: ClientState | null;
  grace?: ReturnType<typeof setTimeout>;
};

export type PlatformServerOptions = {
  port: number;
  host?: string;
  store: PlatformStore;
  model: ModelClient;
};

export class PlatformServer {
  private readonly options: PlatformServerOptions;
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<ClientState>();
  private readonly sessions = new Map<string, LiveSession>();
  private shuttingDown = false;

  constructor(options: PlatformServerOptions) {
    this.options = options;
  }

  async listen(): Promise<{ host: string; port: number }> {
    await this.options.store.load();
    const host = this.options.host ?? "127.0.0.1";

    this.http = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "agent-platform" }));
    });

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => this.onConnection(ws));

    await new Promise<void>((resolve) => {
      this.http!.listen(this.options.port, host, () => resolve());
    });

    const address = this.http!.address();
    if (!address || typeof address === "string") {
      throw new Error("Platform server has no TCP address");
    }
    return { host: address.address, port: address.port };
  }

  /** Drop sockets without stopping the process. Sessions stay resumable for the grace period. */
  dropConnections(): void {
    for (const client of this.clients) {
      client.ws.terminate();
    }
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    for (const client of this.clients) {
      try {
        client.ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    for (const session of [...this.sessions.values()]) {
      await this.expire(session);
    }
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.http?.close((error) => (error ? reject(error) : resolve()));
    });
    this.wss = null;
    this.http = null;
    this.shuttingDown = false;
  }

  private onConnection(ws: WebSocket): void {
    let client: ClientState | null = null;

    const send = (envelope: Envelope) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope));
    };

    ws.on("message", (raw) => {
      void (async () => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(raw.toString()) as Envelope;
        } catch {
          send({ type: "error", message: "Invalid JSON" });
          return;
        }

        try {
          if (!client) {
            client = await this.acceptHello(ws, envelope);
            return;
          }
          await this.handleClientMessage(client, envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: "error", message });
        }
      })();
    });

    ws.on("close", () => {
      if (!client || client.dropped || this.shuttingDown) return;
      client.dropped = true;
      this.clients.delete(client);
      for (const session of this.sessions.values()) {
        if (session.client === client) this.detach(session);
      }
    });
  }

  private async acceptHello(ws: WebSocket, envelope: Envelope): Promise<ClientState | null> {
    const send = (message: Envelope) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    if (envelope.type !== "hello") {
      send({ type: "hello_err", message: "Expected hello", code: "PROTOCOL" });
      ws.close();
      return null;
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      send({
        type: "hello_err",
        code: "PROTOCOL",
        message: `Unsupported protocol version ${String(envelope.protocolVersion)}; this platform speaks version ${PROTOCOL_VERSION}. Upgrade @whitesands/agent-player.`,
      });
      ws.close();
      return null;
    }
    const record = await this.options.store.findKey(envelope.platformKey);
    if (!record) {
      const known = await this.options.store.listKeys();
      send({
        type: "hello_err",
        code: "AUTH",
        message: `Invalid platform key (store has ${known.length} key(s); restart platform after create-key)`,
      });
      ws.close();
      return null;
    }
    const client: ClientState = {
      ws,
      platformKey: record.key,
      accountName: record.name,
      dropped: false,
    };
    this.clients.add(client);
    send({ type: "hello_ok", accountName: record.name, protocolVersion: PROTOCOL_VERSION });
    return client;
  }

  private senderFor(client: ClientState): (envelope: Envelope) => void {
    return (envelope) => {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify(envelope));
      }
    };
  }

  private async handleClientMessage(client: ClientState, envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "start_session":
        await this.startSession(client, envelope);
        return;
      case "stop_session":
        await this.stopSession(client, envelope.sessionId);
        return;
      case "resume_session":
        this.resumeSession(client, envelope.sessionId, envelope.sessionToken);
        return;
      case "mcp": {
        this.sessions.get(envelope.sessionId)?.transport.receive(envelope.message);
        return;
      }
      case "ping":
        this.send(client, { type: "pong", id: envelope.id });
        return;
      case "hello":
      case "hello_ok":
      case "hello_err":
      case "session_started":
      case "session_stopped":
      case "session_resumed":
      case "resume_err":
      case "turn_result":
      case "session_event":
      case "pong":
      case "error":
        return;
      default:
        assertNever(envelope);
    }
  }

  private async startSession(
    client: ClientState,
    envelope: Extract<Envelope, { type: "start_session" }>,
  ): Promise<void> {
    if (this.sessions.has(envelope.sessionId)) {
      throw new Error(`Session already exists: ${envelope.sessionId}`);
    }
    const transport = new PlatformSessionTransport(
      envelope.sessionId,
      this.senderFor(client),
    );
    const loop = new SessionLoop({
      sessionId: envelope.sessionId,
      transport,
      instructions: envelope.instructions,
      ...(envelope.goal ? { goal: envelope.goal } : {}),
      model: this.options.model,
      onUsage: async (tokens) => {
        await this.options.store.addTokenUsage(client.platformKey, tokens);
      },
      onTurnResult: (result) => {
        const current = this.sessions.get(envelope.sessionId)?.client ?? client;
        this.send(current, { type: "turn_result", sessionId: envelope.sessionId, ...result });
      },
      onEvent: (event) => {
        const current = this.sessions.get(envelope.sessionId)?.client;
        if (!current) return;
        const agentEvent = loopEventToAgentEvent(envelope.sessionId, event);
        switch (agentEvent.type) {
          case "action":
            this.send(current, {
              type: "session_event",
              sessionId: envelope.sessionId,
              event: "action",
              action: agentEvent.action,
              args: agentEvent.args,
            });
            return;
          case "retry":
            this.send(current, {
              type: "session_event",
              sessionId: envelope.sessionId,
              event: "retry",
              action: agentEvent.action,
              args: agentEvent.args,
              error: agentEvent.error,
            });
            return;
          case "turnFailed":
            this.send(current, {
              type: "session_event",
              sessionId: envelope.sessionId,
              event: "turnFailed",
              error: agentEvent.error,
              ...(agentEvent.action ? { action: agentEvent.action } : {}),
              ...(agentEvent.args ? { args: agentEvent.args } : {}),
            });
            return;
          case "disconnected":
          case "reconnected":
            return;
          default:
            assertNever(agentEvent);
        }
      },
    });
    this.sessions.set(envelope.sessionId, {
      id: envelope.sessionId,
      token: envelope.sessionToken,
      transport,
      loop,
      client,
    });
    await loop.start();
    this.send(client, { type: "session_started", sessionId: envelope.sessionId });
  }

  private async stopSession(client: ClientState, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await this.expire(session);
    this.send(client, { type: "session_stopped", sessionId });
  }

  private resumeSession(client: ClientState, sessionId: string, sessionToken: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.token !== sessionToken) {
      this.send(client, {
        type: "resume_err",
        sessionId,
        message: "Session cannot be resumed",
      });
      return;
    }
    if (session.grace) clearTimeout(session.grace);
    session.grace = undefined;
    session.client = client;
    session.transport.resume(this.senderFor(client));
    this.send(client, { type: "session_resumed", sessionId });
  }

  private detach(session: LiveSession): void {
    session.client = null;
    session.transport.pause();
    if (session.grace) clearTimeout(session.grace);
    session.grace = setTimeout(() => {
      void this.expire(session);
    }, SESSION_RESUME_GRACE_MS);
    session.grace.unref?.();
  }

  private async expire(session: LiveSession): Promise<void> {
    if (session.grace) clearTimeout(session.grace);
    session.grace = undefined;
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    await session.loop.stop();
  }

  private send(client: ClientState, envelope: Envelope): void {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(envelope));
    }
  }
}
