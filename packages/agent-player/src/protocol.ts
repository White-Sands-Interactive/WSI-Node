/** Wire protocol between AgentServer (SDK) and agent-platform. */

export type ToolArgumentSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: ToolArgumentSchema;
};

export type Envelope =
  | {
      type: "hello";
      platformKey: string;
      clientId: string;
    }
  | {
      type: "hello_ok";
      accountName: string;
    }
  | {
      type: "hello_err";
      message: string;
    }
  | {
      type: "start_session";
      sessionId: string;
      sessionToken: string;
      tools: ToolDescriptor[];
      instructions: string;
    }
  | {
      type: "session_started";
      sessionId: string;
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
  | {
      type: "turn_result";
      sessionId: string;
      ok: boolean;
      error?: string;
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
  "If an action tool returns an error, retry once with a corrected action. A second failure ends the turn as failed.",
].join("\n");
