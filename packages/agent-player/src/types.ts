import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDescriptor } from "./protocol.js";

export type AgentHandle = {
  /** Session id for this started player. */
  readonly sessionId: string;
  /**
   * Grant this session one turn: unblocks wait(), then resolves after the
   * platform completes one action (or rejects after a second tool failure).
   */
  turn(): Promise<void>;
  /** Stop the remote agent for this session. The MCP server for the AgentServer stays up. */
  stop(): Promise<void>;
};

export type StartSessionRequest = {
  sessionId: string;
  sessionToken: string;
  tools: ToolDescriptor[];
  instructions: string;
  /** Client-side MCP transport linked to the session's McpServer. */
  transport: Transport;
  /** Platform reports turn completion here (inline mode). */
  onTurnResult: (result: { ok: boolean; error?: string }) => void;
};

/**
 * In-process platform used for tests and local demos without a network.
 * The real agent-platform package implements the same contract over WebSocket.
 */
export type InlinePlatform = {
  startSession(request: StartSessionRequest): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  close?(): Promise<void>;
};

export type AgentServerOptions = {
  /** Billing / account key from the platform. Required unless `inline` is set. */
  platformKey?: string;
  /** WebSocket URL of the platform. Default: ws://127.0.0.1:8787 */
  platformUrl?: string;
  /**
   * When set, skip the outbound WebSocket and run against this in-process platform.
   * Used by tests and `createInlinePlatform`.
   */
  inline?: InlinePlatform;
  /** Override default agent instructions sent to the platform. */
  instructions?: string;
};
