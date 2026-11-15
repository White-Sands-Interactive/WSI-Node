/**
 * Wire protocol between AgentServer (SDK) and the platform. Version 1.
 */

export const PROTOCOL_VERSION = 1;
export const SDK_VERSION = "1.3.0";

/** How long a disconnected session can be resumed. Shared by both sides. */
export const SESSION_RESUME_GRACE_MS = 30_000;

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type AttemptRecord = {
  action: string;
  args: Record<string, unknown>;
  error: string;
};

export type TurnReport = {
  ok: boolean;
  error?: string;
  action?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  attempts?: number;
  attemptDetails?: AttemptRecord[];
  usage?: TokenUsage;
  connectionLost?: boolean;
  /** Every action played, when the turn played more than one. */
  steps?: StepRecord[];
};

export type StepRecord = {
  action: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

/** How a character feels about one person. affinity runs from -100 to 100. */
export type Relationship = {
  about: string;
  affinity: number;
  label: string;
  note?: string;
};

export type SessionEventName = "action" | "retry" | "turnFailed" | "subgoal" | "memory" | "relationship";

export type Envelope =
  | {
      type: "hello";
      platformKey: string;
      clientId: string;
      protocolVersion: number;
      sdkVersion: string;
    }
  | {
      type: "hello_ok";
      accountName: string;
      protocolVersion: number;
    }
  | {
      type: "hello_err";
      message: string;
      code?: "AUTH" | "PROTOCOL";
    }
  | {
      type: "start_session";
      sessionId: string;
      sessionToken: string;
      /** Character id. One platform key can start every character in that game. */
      playerId: string;
      tools: ToolDescriptor[];
      instructions: string;
      goal?: string;
      name?: string;
      memory?: boolean;
      maxActions?: number;
      subgoals?: boolean;
    }
  | {
      type: "session_started";
      sessionId: string;
      relationships?: Relationship[];
    }
  | {
      type: "observe";
      sessionId: string;
      text: string;
      about?: string;
    }
  | {
      type: "stop_session";
      sessionId: string;
    }
  | {
      type: "session_stopped";
      sessionId: string;
    }
  | {
      type: "mcp";
      sessionId: string;
      message: unknown;
    }
  | ({
      type: "turn_result";
      sessionId: string;
    } & TurnReport)
  | {
      type: "session_event";
      sessionId: string;
      event: SessionEventName;
      action?: string;
      args?: Record<string, unknown>;
      error?: string;
    }
  | {
      type: "ping";
      id: string;
    }
  | {
      type: "pong";
      id: string;
    }
  | {
      type: "resume_session";
      sessionId: string;
      sessionToken: string;
    }
  | {
      type: "session_resumed";
      sessionId: string;
    }
  | {
      type: "resume_err";
      sessionId: string;
      message: string;
    }
  | {
      type: "error";
      message: string;
      sessionId?: string;
    };

export const DEFAULT_AGENT_INSTRUCTIONS = [
  "You are a remote game agent. Tools are provided by the game.",
  "On every turn: call wait first. It blocks until the game grants your turn and then returns the current view from see.",
  "After wait returns, call exactly one action tool (not see, not wait).",
  "The view's done list is what this character has already called in this session, oldest first. Use it when choosing the next action.",
  "If an action tool returns an error, retry once with a corrected action. A second failure ends the turn as failed.",
].join("\n");

const PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trim and check the character id `start_session` must send. */
export function requirePlayerId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (id.length === 0) {
    throw new Error("playerId is required. Copy the character ID from the web app");
  }
  if (!PLAYER_ID.test(id)) {
    throw new Error(`playerId "${id}" is not a character ID. Copy the ID from the character in the web app`);
  }
  return id;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled protocol message: ${JSON.stringify(value)}`);
}
