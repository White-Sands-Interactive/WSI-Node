import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "./protocol.js";

export type EnvelopeSender = (envelope: Envelope) => void;

/**
 * MCP Transport that multiplexes JSON-RPC over a shared envelope channel,
 * keyed by sessionId.
 */
export class SessionMuxTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private readonly sid: string;
  private readonly sendEnvelope: EnvelopeSender;
  private started = false;
  private closed = false;

  constructor(sessionId: string, sendEnvelope: EnvelopeSender) {
    this.sid = sessionId;
    this.sessionId = sessionId;
    this.sendEnvelope = sendEnvelope;
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

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("Transport closed");
    this.sendEnvelope({ type: "mcp", sessionId: this.sid, message });
  }

  /** Deliver an inbound MCP message from the platform. */
  receive(message: unknown): void {
    if (this.closed || !this.started) return;
    try {
      this.onmessage?.(message as JSONRPCMessage);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
