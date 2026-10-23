import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "./logger.js";
import type { AttemptRecord, TokenUsage, ToolDescriptor, TurnReport } from "./protocol.js";

export type TurnResult = {
  action: string;
  args: Record<string, unknown>;
  result: unknown;
  attempts: number;
  usage: TokenUsage;
};

export type AgentEvent =
  | {
      type: "action";
      sessionId: string;
      action: string;
      args: Record<string, unknown>;
    }
  | {
      type: "retry";
      sessionId: string;
      action: string;
      args: Record<string, unknown>;
      error: string;
    }
  | {
      type: "turnFailed";
      sessionId: string;
      error: string;
      action?: string;
      args?: Record<string, unknown>;
    }
  | { type: "disconnected" }
  | { type: "reconnected" };

export type EventListener = (event: AgentEvent) => void;

export type TurnOptions = {
  /** Overrides the server default. The turn rejects with TurnTimeoutError when exceeded. */
  timeoutMs?: number;
  /** Abort the wait for the platform's turn result. */
  signal?: AbortSignal;
};

export type AgentHandle = {
  /** Session id for this started player. */
  readonly sessionId: string;
  /**
   * Grant this session one turn. Resolves with what the agent did, or rejects
   * after a second failed action, a timeout, or a lost connection.
   */
  turn(options?: TurnOptions): Promise<TurnResult>;
  /** Stop the remote agent for this session. The AgentServer stays up. */
  stop(): Promise<void>;
  /** Subscribe to this session's action, retry, and failure events. Returns unsubscribe. */
  on(listener: EventListener): () => void;
};

export type StartOptions = {
  /** Label stored with the session. Defaults to the class name. */
  name?: string;
  /** Added to the model prompt for this player only. */
  goal?: string;
  /** Extra instructions appended to the default agent prompt. */
  instructions?: string;
};

export type StartSessionRequest = {
  sessionId: string;
  sessionToken: string;
  name?: string;
  tools: ToolDescriptor[];
  instructions: string;
  goal?: string;
  logger?: Logger;
  transport: Transport;
  onTurnResult: (result: TurnReport) => void;
  onEvent?: (event: AgentEvent) => void;
  onUsage?: (tokens: number) => void | Promise<void>;
};

/**
 * In-process platform used by `@whitesands/agent-player/testing` and local runs.
 * The hosted platform speaks the same session contract over WebSocket.
 */
export type InlinePlatform = {
  startSession(request: StartSessionRequest): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  close?(): Promise<void>;
};

export type AgentServerOptions = {
  /**
   * Platform key naming the billing account.
   * Defaults to the `WSI_PLATFORM_KEY` environment variable.
   * Not required when `inline` is set.
   */
  platformKey?: string;
  /**
   * WebSocket URL of the platform.
   * Defaults to `WSI_PLATFORM_URL`, then `ws://127.0.0.1:8787`.
   */
  platformUrl?: string;
  /**
   * Skip the outbound WebSocket and run against this in-process platform.
   * `createTestPlatform` from `@whitesands/agent-player/testing` returns one.
   */
  inline?: InlinePlatform;
  /** Replaces the default agent instructions. */
  instructions?: string;
  /** Default timeout for `turn()`. Default: 60 seconds. */
  turnTimeoutMs?: number;
  /** Receives connection and session events for every player on this server. */
  onEvent?: EventListener;
  /** Where the SDK writes warnings. Nothing is written when omitted. */
  logger?: Logger;
  /**
   * SQLite file of actions each character has already called.
   * Later views include that session's `done` list.
   * Defaults to `.wsi/agent-memory.sqlite` in the current directory.
   * Pass false to keep no action history.
   */
  memoryPath?: string | false;
};

export type { AttemptRecord, TokenUsage, ToolDescriptor, TurnReport };
