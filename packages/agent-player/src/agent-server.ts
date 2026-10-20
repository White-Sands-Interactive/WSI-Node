import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEFAULT_AGENT_INSTRUCTIONS, type Envelope } from "./protocol.js";
import { PlatformConnection } from "./platform-connection.js";
import { reflectPlayer } from "./reflect.js";
import { createSessionMcpServer } from "./session-mcp.js";
import { TurnGate } from "./turn-gate.js";
import type { AgentHandle, AgentServerOptions, InlinePlatform } from "./types.js";
import { SessionMuxTransport } from "./ws-transport.js";

type SessionRecord = {
  id: string;
  token: string;
  gate: TurnGate;
  server: McpServer;
  transport: Transport;
  mux?: SessionMuxTransport;
};

/**
 * Boots one in-process MCP server hub and an outbound (or inline) platform connection.
 * Two players share this server; each start() is its own session and token.
 */
export class AgentServer {
  private readonly options: AgentServerOptions;
  private readonly platformKey: string;
  private connection: PlatformConnection | null = null;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly inline: InlinePlatform | undefined;
  private started = false;
  private closing = false;

  constructor(options: AgentServerOptions) {
    if (!options.inline && !options.platformKey) {
      throw new Error("platformKey is required unless inline platform is provided");
    }
    this.options = options;
    this.platformKey = options.platformKey || "inline";
    this.inline = options.inline;
  }

  /** Ensure outbound platform connection (no-op for inline). */
  async connect(): Promise<void> {
    if (this.inline || this.started) {
      this.started = true;
      return;
    }
    const url = this.options.platformUrl ?? "ws://127.0.0.1:8787";
    this.connection = new PlatformConnection(url, this.platformKey, {
      onEnvelope: (envelope) => this.handleEnvelope(envelope),
      onError: (err) => {
        console.error("[agent-player] platform error:", err.message);
      },
    });
    await this.connection.connect();
    this.started = true;
  }

  /**
   * Reflect the player instance into tools, register a session with the platform,
   * and return a handle whose turn() drives one agent action.
   */
  async start(instance: object): Promise<AgentHandle> {
    await this.connect();

    const reflected = reflectPlayer(instance);
    const sessionId = randomUUID();
    const sessionToken = randomUUID();
    const gate = new TurnGate();
    const server = createSessionMcpServer(reflected, gate, {
      name: `agent-player:${sessionId.slice(0, 8)}`,
    });

    const instructions = this.options.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;

    if (this.inline) {
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const record: SessionRecord = {
        id: sessionId,
        token: sessionToken,
        gate,
        server,
        transport: serverTransport,
      };
      this.sessions.set(sessionId, record);

      await this.inline.startSession({
        sessionId,
        sessionToken,
        tools: reflected.tools,
        instructions,
        transport: clientTransport,
        onTurnResult: (result) => {
          gate.completeTurn(
            result.ok ? { ok: true } : { ok: false, error: result.error ?? "turn failed" },
          );
        },
      });
    } else {
      if (!this.connection) throw new Error("Not connected");
      const mux = this.connection.createTransport(sessionId);
      await server.connect(mux);
      const record: SessionRecord = {
        id: sessionId,
        token: sessionToken,
        gate,
        server,
        transport: mux,
        mux,
      };
      this.sessions.set(sessionId, record);

      const started = this.connection.waitForSessionEvent(sessionId, "start");
      this.connection.send({
        type: "start_session",
        sessionId,
        sessionToken,
        tools: reflected.tools,
        instructions,
      });
      await started;
    }

    return {
      sessionId,
      turn: async () => {
        const outcome = await gate.runTurn();
        if (!outcome.ok) {
          throw new Error(outcome.error);
        }
      },
      stop: async () => {
        await this.stopSession(sessionId);
      },
    };
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.type) {
      case "mcp": {
        const session = this.sessions.get(envelope.sessionId);
        session?.mux?.receive(envelope.message);
        return;
      }
      case "turn_result": {
        const session = this.sessions.get(envelope.sessionId);
        if (!session) return;
        session.gate.completeTurn(
          envelope.ok
            ? { ok: true }
            : { ok: false, error: envelope.error ?? "turn failed" },
        );
        return;
      }
      case "session_started":
      case "session_stopped":
      case "hello_ok":
      case "hello_err":
      case "error":
      case "hello":
      case "start_session":
      case "stop_session":
        return;
      default: {
        const _exhaustive: never = envelope;
        void _exhaustive;
        return;
      }
    }
  }

  private async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.gate.reset();

    if (this.inline) {
      await this.inline.stopSession(sessionId);
    } else if (this.connection) {
      const stopped = this.connection.waitForSessionEvent(sessionId, "stop").catch(() => null);
      try {
        this.connection.send({ type: "stop_session", sessionId });
      } catch {
        // connection may already be down
      }
      await stopped;
    }

    try {
      await session.server.close();
    } catch {
      // ignore
    }
  }

  /** Stop all sessions and close the platform connection. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.stopSession(id);
    }
    if (this.inline?.close) {
      await this.inline.close();
    }
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
    this.started = false;
    this.closing = false;
  }
}
