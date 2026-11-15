import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "./logger.js";
import type { AttemptRecord, Relationship, StepRecord, TokenUsage, ToolDescriptor, TurnReport } from "./protocol.js";

export type TurnResult = {
  action: string;
  args: Record<string, unknown>;
  result: unknown;
  attempts: number;
  usage: TokenUsage;
  /** Every action played, when the turn played more than one. */
  steps?: StepRecord[];
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
  | {
      /** The character chose to remember a fact. Needs `memory: true`. */
      type: "memory";
      sessionId: string;
      about: string;
      note: string;
    }
  | {
      /** The character's feelings about someone changed. Needs `memory: true`. */
      type: "relationship";
      sessionId: string;
      about: string;
      affinity: number;
      label: string;
      change: number;
      because: string;
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
  /**
   * Tell the character about something that happened, without starting a turn.
   * It is kept in the character's memory. Needs `memory: true`.
   */
  observe(text: string, about?: string): void;
  /** How the character feels about each person it knows, keyed by lower-case name. */
  relationships(): Record<string, Relationship>;
};

export type StartOptions = {
  /**
   * Character to play. Copy the id from the Players page.
   * The platform key belongs to the game; this id selects the character.
   */
  playerId: string;
  /** Label stored with the session. Defaults to the class name. */
  name?: string;
  /** Added to the model prompt for this player only. */
  goal?: string;
  /** Extra instructions appended to the default agent prompt. */
  instructions?: string;
  /** Send only `instructions`, without the default agent prompt. */
  ownInstructions?: boolean;
  /**
   * Keep the character's memory and relationships on the platform, between
   * sessions and servers. The local `done` list is left out of the view.
   */
  memory?: boolean;
  /** How many actions one turn may play, 1 to 4. Default 1. */
  maxActions?: number;
  /** false takes the platform's subgoal tools away. */
  subgoals?: boolean;
};

export type StartSessionRequest = {
  sessionId: string;
  sessionToken: string;
  playerId: string;
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
   * Defaults to `wss://api.whitesandsint.com`.
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

export type { AttemptRecord, Relationship, StepRecord, TokenUsage, ToolDescriptor, TurnReport };
