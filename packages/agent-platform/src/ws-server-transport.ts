import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "@whitesands/agent-player/protocol";

export type EnvelopeSender = (envelope: Envelope) => void;

/** Platform-side MCP transport multiplexed over the SDK WebSocket. */
export class PlatformSessionTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private readonly sid: string;
  private sender: EnvelopeSender;
  private started = false;
  private closed = false;
  private paused = false;
  private readonly buffer: JSONRPCMessage[] = [];

  constructor(sessionId: string, sendEnvelope: EnvelopeSender) {
    this.sid = sessionId;
    this.sessionId = sessionId;
    this.sender = sendEnvelope;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Transport already closed");
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  pause(): void {
    this.paused = true;
  }

  /** Point outbound MCP messages at a new socket and flush anything queued while paused. */
  resume(sendEnvelope: EnvelopeSender): void {
    this.sender = sendEnvelope;
    this.paused = false;
    const queued = this.buffer.splice(0, this.buffer.length);
    for (const message of queued) {
      this.sender({ type: "mcp", sessionId: this.sid, message });
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("Transport closed");
    if (this.paused) {
      this.buffer.push(message);
      return;
    }
    this.sender({ type: "mcp", sessionId: this.sid, message });
  }

  receive(message: unknown): void {
    if (this.closed || !this.started) return;
    try {
      this.onmessage?.(message as JSONRPCMessage);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
