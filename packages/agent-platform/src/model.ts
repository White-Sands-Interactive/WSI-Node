import {
  createScriptedModel,
  type ModelClient,
  type ModelDecision,
  type ModelMessage,
  type ToolCallRequest,
} from "@whitesands/agent-player/testing";

export { createScriptedModel };
export type { ModelClient, ModelDecision, ModelMessage, ToolCallRequest };

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
        tools: tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: "required" as const,
        messages: [
          { role: "system", content: instructions },
          ...messages.map((message) => {
            if (message.role === "tool") {
              return {
                role: "user" as const,
                content: `Tool ${message.name} returned${message.isError ? " ERROR" : ""}: ${message.content}`,
              };
            }
            return { role: message.role, content: message.content };
          }),
        ],
      };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Model request failed (${response.status}): ${text}`);
      }

      const json = (await response.json()) as {
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
