import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectionLostError, TurnFailedError } from "./errors.js";
import type { Logger } from "./logger.js";
import { log } from "./logger.js";
import { defaultMemoryPath, SessionMemory } from "./memory.js";
import { PlatformConnection } from "./platform-connection.js";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  assertNever,
  type Envelope,
  type Relationship,
  type TurnReport,
} from "./protocol.js";
import { reflectPlayer } from "./reflect.js";
import { createSessionMcpServer } from "./session-mcp.js";
import { TurnGate } from "./turn-gate.js";
import type {
  AgentEvent,
  AgentHandle,
  AgentServerOptions,
  EventListener,
  InlinePlatform,
  StartOptions,
  TurnOptions,
  TurnResult,
} from "./types.js";
import { SessionMuxTransport } from "./ws-transport.js";

const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const PLATFORM_URL = "wss://api.whitesandsint.com";

type SessionRecord = {
  id: string;
  token: string;
  name: string;
  gate: TurnGate;
  server: McpServer;
  transport: Transport;
  mux?: SessionMuxTransport;
  listeners: Set<EventListener>;
  memory: boolean;
  relationships: Map<string, Relationship>;
};

/**
 * One in-process MCP server and one outbound connection to the platform.
 * Every `start()` is its own session and token. The game calls `turn()` to
 * decide whose turn it is; the platform chooses the action.
 */
export class AgentServer {
  private readonly options: AgentServerOptions;
  private readonly platformKey: string;
  private readonly platformUrl: string;
  private readonly logger: Logger | undefined;
  private connection: PlatformConnection | null = null;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<EventListener>();
  private readonly inline: InlinePlatform | undefined;
  private memory: SessionMemory | null = null;
  private started = false;
  private closing = false;

  constructor(options: AgentServerOptions = {}) {
    const platformKey = options.platformKey ?? process.env.WSI_PLATFORM_KEY;
    if (!options.inline && !platformKey) {
      throw new Error("Set WSI_PLATFORM_KEY or pass platformKey, unless an inline platform is provided");
    }
    this.options = options;
    this.platformKey = platformKey || "inline";
    this.platformUrl = options.platformUrl ?? PLATFORM_URL;
    this.logger = options.logger;
    this.inline = options.inline;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  /** Ensure the outbound platform connection. No-op for an inline platform. */
  async connect(): Promise<void> {
    if (this.inline || this.started) {
      this.started = true;
      return;
    }
    this.connection = new PlatformConnection(this.platformUrl, this.platformKey, {
      onEnvelope: (envelope) => this.handleEnvelope(envelope),
      onDisconnect: () => this.emit({ type: "disconnected" }),
      onReconnect: () => this.emit({ type: "reconnected" }),
      onError: (error) => {
        log(this.logger, "error", error.message);
        if (error instanceof ConnectionLostError) this.failInflight(error);
      },
      sessions: () => [...this.sessions.values()].map((session) => ({
        sessionId: session.id,
        sessionToken: session.token,
      })),
    }, this.logger);
    await this.connection.connect();
    this.started = true;
  }

  /**
   * Reflect the player into tools, register a session, and return a handle.
   * `turn()` on that handle lets the remote model act once.
   */
  async start(instance: object, options?: StartOptions): Promise<AgentHandle> {
    await this.connect();

    const reflected = reflectPlayer(instance);
    const sessionId = randomUUID();
    const sessionToken = randomUUID();
    const gate = new TurnGate();
    const name = options?.name ?? instance.constructor?.name ?? "player";
    const memory = options?.memory ? null : this.actionMemory();
    const server = createSessionMcpServer(reflected, gate, {
      name: `agent-player:${name}`,
      ...(memory
        ? {
            actions: {
              record: (entry) => memory.record(sessionId, name, entry),
              done: () => memory.done(sessionId),
            },
          }
        : {}),
    });
    const instructions = [
      options?.ownInstructions ? undefined : this.options.instructions ?? DEFAULT_AGENT_INSTRUCTIONS,
      options?.instructions,
    ]
      .filter((part): part is string => Boolean(part && part.length > 0))
      .join("\n\n");

    const listeners = new Set<EventListener>();
    const record: SessionRecord = {
      id: sessionId,
      token: sessionToken,
      name,
      gate,
      server,
      transport: undefined as unknown as Transport,
      listeners,
      memory: options?.memory === true,
      relationships: new Map(),
    };

    const onTurnResult = (result: TurnReport) => {
      gate.completeTurn(result);
    };
    const onEvent = (event: AgentEvent) => this.emit(event);

    if (this.inline) {
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      record.transport = serverTransport;
      this.sessions.set(sessionId, record);
      await this.inline.startSession({
        sessionId,
        sessionToken,
        name,
        tools: reflected.tools,
        instructions,
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(this.logger ? { logger: this.logger } : {}),
        transport: clientTransport,
        onTurnResult,
        onEvent,
      });
    } else {
      if (!this.connection) throw new Error("Not connected");
      const mux = this.connection.createTransport(sessionId);
      await server.connect(mux);
      record.transport = mux;
      record.mux = mux;
      this.sessions.set(sessionId, record);
      const started = this.connection.waitForSessionEvent(sessionId, "start");
      this.connection.send({
        type: "start_session",
        sessionId,
        sessionToken,
        name,
        tools: reflected.tools,
        instructions,
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(options?.playerId ? { playerId: options.playerId } : {}),
        ...(options?.memory ? { memory: true } : {}),
        ...(options?.maxActions ? { maxActions: options.maxActions } : {}),
        ...(options?.subgoals === false ? { subgoals: false } : {}),
      });
      const ack = await started;
      if (ack.type === "session_started") {
        for (const relationship of ack.relationships ?? []) {
          record.relationships.set(relationship.about.toLowerCase(), relationship);
        }
      }
    }

    return {
      sessionId,
      turn: (turnOptions?: TurnOptions) => this.turn(sessionId, turnOptions),
      stop: () => this.stopSession(sessionId),
      on: (listener: EventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      observe: (text: string, about?: string) => {
        if (!record.memory || !text || !this.connection || !this.sessions.has(sessionId)) return;
        try {
          this.connection.send({ type: "observe", sessionId, text, ...(about ? { about } : {}) });
        } catch {
          // The event is lost while the connection is down.
        }
      },
      relationships: () => Object.fromEntries(record.relationships),
    };
  }

  /** Subscribe to every session plus connection events. Returns unsubscribe. */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async turn(sessionId: string, options?: TurnOptions): Promise<TurnResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const timeoutMs = options?.timeoutMs ?? this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    let outcome: TurnReport;
    try {
      outcome = await session.gate.runTurn({
        timeoutMs,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof ConnectionLostError) throw error;
      throw error;
    }
    if (!outcome.ok) {
      if (outcome.connectionLost) {
        throw new ConnectionLostError(outcome.error ?? "Connection to the platform was lost");
      }
      throw new TurnFailedError(outcome.error ?? "turn failed", outcome.attemptDetails ?? []);
    }
    return {
      action: outcome.action ?? "unknown",
      args: outcome.args ?? {},
      result: outcome.result,
      attempts: outcome.attempts ?? 1,
      usage: outcome.usage ?? { promptTokens: 0, completionTokens: 0 },
      ...(outcome.steps ? { steps: outcome.steps } : {}),
    };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
    if (event.type === "disconnected" || event.type === "reconnected") return;
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    for (const listener of session.listeners) listener(event);
  }

  private failInflight(error: ConnectionLostError): void {
    for (const session of this.sessions.values()) {
      session.gate.failTurn(error);
    }
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
        session?.gate.completeTurn(envelope);
        return;
      }
      case "session_event": {
        if (envelope.event === "action") {
          this.emit({
            type: "action",
            sessionId: envelope.sessionId,
            action: envelope.action ?? "unknown",
            args: envelope.args ?? {},
          });
          return;
        }
        if (envelope.event === "retry") {
          this.emit({
            type: "retry",
            sessionId: envelope.sessionId,
            action: envelope.action ?? "unknown",
            args: envelope.args ?? {},
            error: envelope.error ?? "action failed",
          });
          return;
        }
        if (envelope.event === "relationship" || envelope.event === "memory") {
          if (envelope.error) return;
          const args = envelope.args ?? {};
          const about = typeof args.about === "string" ? args.about : "";
          if (envelope.event === "memory") {
            this.emit({ type: "memory", sessionId: envelope.sessionId, about, note: String(args.note ?? "") });
            return;
          }
          const relationship: Relationship = {
            about,
            affinity: Number(args.affinity ?? 0),
            label: String(args.label ?? "stranger"),
            note: String(args.because ?? ""),
          };
          this.sessions.get(envelope.sessionId)?.relationships.set(about.toLowerCase(), relationship);
          this.emit({
            type: "relationship",
            sessionId: envelope.sessionId,
            about,
            affinity: relationship.affinity,
            label: relationship.label,
            change: Number(args.change ?? 0),
            because: relationship.note ?? "",
          });
          return;
        }
        if (envelope.event !== "turnFailed") return;
        this.emit({
          type: "turnFailed",
          sessionId: envelope.sessionId,
          error: envelope.error ?? "turn failed",
          ...(envelope.action ? { action: envelope.action } : {}),
          ...(envelope.args ? { args: envelope.args } : {}),
        });
        return;
      }
      case "error":
        log(this.logger, "error", envelope.message);
        return;
      case "session_started":
      case "session_stopped":
      case "session_resumed":
      case "resume_err":
      case "hello_ok":
      case "hello_err":
      case "hello":
      case "start_session":
      case "stop_session":
      case "ping":
      case "pong":
      case "resume_session":
      case "observe":
        return;
      default: {
        assertNever(envelope);
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

  /** Stop every session and close the platform connection. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.stopSession(id);
    }
    if (this.inline?.close) await this.inline.close();
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
    this.memory?.close();
    this.memory = null;
    this.started = false;
    this.closing = false;
  }

  private actionMemory(): SessionMemory | null {
    if (this.options.memoryPath === false) return null;
    if (!this.memory) {
      const path = this.options.memoryPath ?? defaultMemoryPath();
      this.memory = new SessionMemory(path);
    }
    return this.memory;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
