import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Envelope } from "./protocol.js";
import { SessionMuxTransport } from "./ws-transport.js";

export type PlatformConnectionHandlers = {
  onEnvelope: (envelope: Envelope) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

/**
 * Outbound WebSocket to the platform. The game never listens on a public URL.
 */
export class PlatformConnection {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly platformKey: string;
  readonly clientId = randomUUID();
  private readonly handlers: PlatformConnectionHandlers;
  private readonly pending = new Map<
    string,
    { resolve: (e: Envelope) => void; reject: (err: Error) => void }
  >();
  private accountName: string | null = null;

  constructor(url: string, platformKey: string, handlers: PlatformConnectionHandlers) {
    this.url = url;
    this.platformKey = platformKey;
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<string> {
    if (this.ws) return this.accountName ?? "unknown";

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on("open", () => {
        this.send({
          type: "hello",
          platformKey: this.platformKey,
          clientId: this.clientId,
        });
      });

      ws.on("message", (data) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(data.toString()) as Envelope;
        } catch (error) {
          this.handlers.onError?.(
            error instanceof Error ? error : new Error("Invalid platform message"),
          );
          return;
        }

        if (envelope.type === "hello_ok") {
          this.accountName = envelope.accountName;
          resolve();
          return;
        }
        if (envelope.type === "hello_err") {
          reject(new Error(envelope.message));
          void this.close();
          return;
        }

        if (
          envelope.type === "session_started" ||
          envelope.type === "session_stopped" ||
          envelope.type === "turn_result"
        ) {
          const key =
            envelope.type === "turn_result"
              ? `turn:${envelope.sessionId}`
              : `${envelope.type}:${envelope.sessionId}`;
          // turn_result is delivered to handlers; session_started/stopped may wait
          if (envelope.type !== "turn_result") {
            const waiter = this.pending.get(`session:${envelope.sessionId}:${envelope.type === "session_started" ? "start" : "stop"}`);
            if (waiter) {
              this.pending.delete(`session:${envelope.sessionId}:${envelope.type === "session_started" ? "start" : "stop"}`);
              waiter.resolve(envelope);
            }
          }
          void key;
        }

        this.handlers.onEnvelope(envelope);
      });

      ws.on("error", (err) => {
        this.handlers.onError?.(err);
        reject(err);
      });

      ws.on("close", () => {
        this.ws = null;
        for (const [, waiter] of this.pending) {
          waiter.reject(new Error("platform connection closed"));
        }
        this.pending.clear();
        this.handlers.onClose?.();
      });
    });

    return this.accountName ?? "unknown";
  }

  send(envelope: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to platform");
    }
    this.ws.send(JSON.stringify(envelope));
  }

  waitForSessionEvent(
    sessionId: string,
    kind: "start" | "stop",
    timeoutMs = 15_000,
  ): Promise<Envelope> {
    const key = `session:${sessionId}:${kind}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for session ${kind}`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  createTransport(sessionId: string): SessionMuxTransport {
    return new SessionMuxTransport(sessionId, (envelope) => this.send(envelope));
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
