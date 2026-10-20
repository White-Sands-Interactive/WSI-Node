import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Envelope } from "@wsi/agent-player/protocol";
import type { ModelClient } from "./model.js";
import { SessionLoop } from "./session-loop.js";
import type { PlatformStore } from "./store.js";
import { PlatformSessionTransport } from "./ws-server-transport.js";

type ClientState = {
  ws: WebSocket;
  platformKey: string;
  accountName: string;
  sessions: Map<
    string,
    {
      transport: PlatformSessionTransport;
      loop: SessionLoop;
    }
  >;
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

    return { host, port: this.options.port };
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      await this.dropClient(client);
    }
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.http?.close((err) => (err ? reject(err) : resolve()));
    });
    this.wss = null;
    this.http = null;
  }

  private onConnection(ws: WebSocket): void {
    let client: ClientState | null = null;

    ws.on("message", (raw) => {
      void (async () => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(raw.toString()) as Envelope;
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" } satisfies Envelope));
          return;
        }

        try {
          if (!client) {
            if (envelope.type !== "hello") {
              ws.send(
                JSON.stringify({
                  type: "hello_err",
                  message: "Expected hello",
                } satisfies Envelope),
              );
              ws.close();
              return;
            }
            const record = await this.options.store.findKey(envelope.platformKey);
            if (!record) {
              const known = await this.options.store.listKeys();
              ws.send(
                JSON.stringify({
                  type: "hello_err",
                  message: `Invalid platform key (store has ${known.length} key(s); restart platform after create-key)`,
                } satisfies Envelope),
              );
              ws.close();
              return;
            }
            client = {
              ws,
              platformKey: record.key,
              accountName: record.name,
              sessions: new Map(),
            };
            this.clients.add(client);
            ws.send(
              JSON.stringify({
                type: "hello_ok",
                accountName: record.name,
              } satisfies Envelope),
            );
            return;
          }

          await this.handleClientMessage(client, envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ws.send(JSON.stringify({ type: "error", message } satisfies Envelope));
        }
      })();
    });

    ws.on("close", () => {
      if (client) {
        void this.dropClient(client);
      }
    });
  }

  private async handleClientMessage(client: ClientState, envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "start_session": {
        if (client.sessions.has(envelope.sessionId)) {
          throw new Error(`Session already exists: ${envelope.sessionId}`);
        }
        const transport = new PlatformSessionTransport(envelope.sessionId, (env) => {
          if (client.ws.readyState === client.ws.OPEN) {
            client.ws.send(JSON.stringify(env));
          }
        });
        const loop = new SessionLoop({
          sessionId: envelope.sessionId,
          transport,
          instructions: envelope.instructions,
          model: this.options.model,
          onUsage: async (tokens) => {
            await this.options.store.addTokenUsage(client.platformKey, tokens);
          },
          onTurnResult: (result) => {
            if (client.ws.readyState === client.ws.OPEN) {
              client.ws.send(
                JSON.stringify({
                  type: "turn_result",
                  sessionId: envelope.sessionId,
                  ok: result.ok,
                  error: result.error,
                } satisfies Envelope),
              );
            }
          },
        });
        client.sessions.set(envelope.sessionId, { transport, loop });
        await loop.start();
        client.ws.send(
          JSON.stringify({
            type: "session_started",
            sessionId: envelope.sessionId,
          } satisfies Envelope),
        );
        return;
      }
      case "stop_session": {
        const session = client.sessions.get(envelope.sessionId);
        if (session) {
          client.sessions.delete(envelope.sessionId);
          await session.loop.stop();
        }
        client.ws.send(
          JSON.stringify({
            type: "session_stopped",
            sessionId: envelope.sessionId,
          } satisfies Envelope),
        );
        return;
      }
      case "mcp": {
        const session = client.sessions.get(envelope.sessionId);
        session?.transport.receive(envelope.message);
        return;
      }
      case "hello":
      case "hello_ok":
      case "hello_err":
      case "session_started":
      case "session_stopped":
      case "turn_result":
      case "error":
        return;
      default: {
        const _exhaustive: never = envelope;
        void _exhaustive;
        return;
      }
    }
  }

  private async dropClient(client: ClientState): Promise<void> {
    this.clients.delete(client);
    for (const [id, session] of client.sessions) {
      client.sessions.delete(id);
      await session.loop.stop();
    }
    try {
      client.ws.close();
    } catch {
      // ignore
    }
  }
}
