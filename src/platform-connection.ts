import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ConnectionLostError, PlatformAuthError, ProtocolVersionError } from "./errors.js";
import type { Logger } from "./logger.js";
import { log } from "./logger.js";
import {
  PROTOCOL_VERSION,
  SDK_VERSION,
  SESSION_RESUME_GRACE_MS,
  type Envelope,
} from "./protocol.js";
import { SessionMuxTransport } from "./ws-transport.js";

export type ResumableSession = {
  sessionId: string;
  sessionToken: string;
};

export type PlatformConnectionHandlers = {
  onEnvelope: (envelope: Envelope) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
  onError?: (error: Error) => void;
  sessions?: () => ResumableSession[];
};

const HEARTBEAT_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Outbound WebSocket to the platform. The game never listens on a public URL.
 * After the first successful hello, a dropped socket reconnects and resumes sessions.
 */
export class PlatformConnection {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly platformKey: string;
  readonly clientId = randomUUID();
  private readonly handlers: PlatformConnectionHandlers;
  private readonly logger: Logger | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (envelope: Envelope) => void; reject: (error: Error) => void }
  >();
  private readonly outbox: Envelope[] = [];
  private accountName: string | null = null;
  private closed = false;
  private everConnected = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPong: string | null = null;

  constructor(
    url: string,
    platformKey: string,
    handlers: PlatformConnectionHandlers,
    logger?: Logger,
  ) {
    this.url = url;
    this.platformKey = platformKey;
    this.handlers = handlers;
    this.logger = logger;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<string> {
    if (this.closed) throw new Error("Platform connection is closed");
    if (this.connected && this.accountName) return this.accountName;
    const account = await this.openSocket();
    this.everConnected = true;
    this.reconnectAttempt = 0;
    return account;
  }

  send(envelope: Envelope): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(envelope));
      return;
    }
    if (envelope.type === "mcp" || envelope.type === "ping") {
      this.outbox.push(envelope);
      return;
    }
    throw new Error("Not connected to platform");
  }

  waitForSessionEvent(
    sessionId: string,
    kind: "start" | "stop" | "resume",
    timeoutMs = 15_000,
  ): Promise<Envelope> {
    const key = `session:${sessionId}:${kind}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for session ${kind}`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (envelope) => {
          clearTimeout(timer);
          resolve(envelope);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  createTransport(sessionId: string): SessionMuxTransport {
    return new SessionMuxTransport(sessionId, (envelope) => this.send(envelope));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnecting = false;
    this.failWaiters(new Error("platform connection closed"));
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  private openSocket(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "hello",
          platformKey: this.platformKey,
          clientId: this.clientId,
          protocolVersion: PROTOCOL_VERSION,
          sdkVersion: SDK_VERSION,
        } satisfies Envelope));
      });

      ws.on("message", (data) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(data.toString()) as Envelope;
        } catch (error) {
          const parsed = error instanceof Error ? error : new Error("Invalid platform message");
          this.handlers.onError?.(parsed);
          return;
        }

        if (!settled && (envelope.type === "hello_ok" || envelope.type === "hello_err")) {
          settled = true;
          if (envelope.type === "hello_err") {
            const error = envelope.code === "PROTOCOL"
              ? new ProtocolVersionError(envelope.message)
              : new PlatformAuthError(envelope.message);
            this.closed = true;
            reject(error);
            ws.close();
            return;
          }
          this.accountName = envelope.accountName;
          this.startHeartbeat();
          this.flushOutbox();
          resolve(envelope.accountName);
          return;
        }

        if (envelope.type === "pong") {
          if (this.pendingPong === envelope.id) {
            this.pendingPong = null;
            if (this.pongTimer) clearTimeout(this.pongTimer);
            this.pongTimer = undefined;
          }
          return;
        }

        this.resolveSessionWaiter(envelope);
        this.handlers.onEnvelope(envelope);
      });

      ws.on("error", (error) => {
        this.handlers.onError?.(error);
        fail(error);
      });

      ws.on("close", () => {
        this.stopHeartbeat();
        if (this.ws === ws) this.ws = null;
        if (!settled) fail(new Error("platform connection closed before hello"));
        if (this.closed || !this.everConnected) {
          this.failWaiters(new Error("platform connection closed"));
          return;
        }
        this.handlers.onDisconnect?.();
        this.scheduleReconnect();
      });
    });
  }

  private resolveSessionWaiter(envelope: Envelope): void {
    if (envelope.type === "session_started" || envelope.type === "session_stopped") {
      const kind = envelope.type === "session_started" ? "start" : "stop";
      const waiter = this.pending.get(`session:${envelope.sessionId}:${kind}`);
      if (!waiter) return;
      this.pending.delete(`session:${envelope.sessionId}:${kind}`);
      waiter.resolve(envelope);
      return;
    }
    if (envelope.type === "session_resumed" || envelope.type === "resume_err") {
      const waiter = this.pending.get(`session:${envelope.sessionId}:resume`);
      if (!waiter) return;
      this.pending.delete(`session:${envelope.sessionId}:resume`);
      if (envelope.type === "resume_err") {
        waiter.reject(new ConnectionLostError(envelope.message));
        return;
      }
      waiter.resolve(envelope);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.closed = true;
      const error = new ConnectionLostError("Could not reconnect to the platform");
      this.handlers.onError?.(error);
      this.failWaiters(error);
      return;
    }
    const delay = Math.min(SESSION_RESUME_GRACE_MS, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnecting = true;
    log(this.logger, "warn", `platform connection dropped; retrying in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    try {
      await this.openSocket();
      this.everConnected = true;
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      const sessions = this.handlers.sessions?.() ?? [];
      for (const session of sessions) {
        const resumed = this.waitForSessionEvent(session.sessionId, "resume");
        this.send({
          type: "resume_session",
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        });
        await resumed;
      }
      this.handlers.onReconnect?.();
    } catch (error) {
      this.reconnecting = false;
      if (this.closed) return;
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (wrapped instanceof PlatformAuthError || wrapped instanceof ProtocolVersionError) {
        this.closed = true;
        this.handlers.onError?.(wrapped);
        this.failWaiters(wrapped);
        return;
      }
      this.scheduleReconnect();
    }
  }

  private flushOutbox(): void {
    if (!this.ws || !this.connected) return;
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const envelope of pending) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.connected) return;
      const id = randomUUID();
      this.pendingPong = id;
      try {
        this.send({ type: "ping", id });
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        if (this.pendingPong === id) {
          log(this.logger, "warn", "platform heartbeat timed out");
          this.ws?.terminate();
        }
      }, PONG_TIMEOUT_MS);
      this.pongTimer.unref?.();
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeat = undefined;
    this.pongTimer = undefined;
    this.pendingPong = null;
  }

  private failWaiters(error: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }
}
