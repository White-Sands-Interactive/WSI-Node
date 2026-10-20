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

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * One model chosen by the platform environment.
 * Uses an OpenAI-compatible chat completions endpoint.
 */
export function createOpenAiModel(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): ModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

  return {
    async decide({ instructions, tools, messages }) {
      const body = {
        model: options.model,
        temperature: 0,
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        tool_choice: "required" as const,
        messages: [
          { role: "system", content: instructions },
          ...messages.map((m) => {
            if (m.role === "tool") {
              return {
                role: "user" as const,
                content: `Tool ${m.name} returned${m.isError ? " ERROR" : ""}: ${m.content}`,
              };
            }
            return { role: m.role, content: m.content };
          }),
        ],
      };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Model request failed (${res.status}): ${text}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { tool_calls?: OpenAiToolCall[]; content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const toolCalls = json.choices?.[0]?.message?.tool_calls;
      if (!toolCalls?.length) {
        throw new Error("Model returned no tool call");
      }

      const first = toolCalls[0]!;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(first.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }

      return {
        toolCall: { name: first.function.name, arguments: args },
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelClient {
  if (env.PLATFORM_SCRIPTED_MODEL) {
    const script = JSON.parse(env.PLATFORM_SCRIPTED_MODEL) as ToolCallRequest[];
    return createScriptedModel(script);
  }
  const apiKey = env.MODEL_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("MODEL_API_KEY (or OPENAI_API_KEY) is required for the platform model");
  }
  return createOpenAiModel({
    apiKey,
    model: env.MODEL_NAME ?? "gpt-4o-mini",
    baseUrl: env.MODEL_BASE_URL,
  });
}
