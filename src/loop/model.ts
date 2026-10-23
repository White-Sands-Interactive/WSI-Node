export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; name: string; content: string; isError?: boolean };

export type ModelDecision = {
  toolCall: ToolCallRequest;
  usage: { promptTokens: number; completionTokens: number };
};

export type ModelClient = {
  /** Ask the model to choose exactly one tool call. */
  decide(args: {
    instructions: string;
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    messages: ModelMessage[];
  }): Promise<ModelDecision>;
};

/**
 * Scripted model for tests: returns predetermined tool calls in order.
 * When the queue is exhausted, always returns wait.
 */
export function createScriptedModel(script: ToolCallRequest[]): ModelClient {
  let index = 0;
  return {
    async decide() {
      const call = script[index] ?? { name: "wait", arguments: {} };
      index += 1;
      return {
        toolCall: call,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };
}
