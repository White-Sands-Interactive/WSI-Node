import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ModelClient, ModelMessage, ToolCallRequest } from "./model.js";

export type SessionLoopOptions = {
  sessionId: string;
  transport: Transport;
  instructions: string;
  model: ModelClient;
  onUsage: (tokens: number) => void | Promise<void>;
  onTurnResult: (result: { ok: boolean; error?: string }) => void;
};

function parseToolPayload(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): { isError: boolean; text: string; json: unknown } {
  const text = result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n");
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep text
  }
  return { isError: Boolean(result.isError), text, json };
}

/**
 * Per-session MCP client loop:
 * wait → read view → ask model → one action → retry once on error → report turn.
 */
export class SessionLoop {
  private readonly options: SessionLoopOptions;
  private client: Client | null = null;
  private stopped = false;
  private runPromise: Promise<void> | null = null;

  constructor(options: SessionLoopOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.runPromise) return;
    const client = new Client({ name: "agent-platform", version: "0.1.0" });
    await client.connect(this.options.transport);
    this.client = client;
    this.runPromise = this.run().catch((error) => {
      if (!this.stopped) {
        console.error(`[agent-platform] session ${this.options.sessionId} crashed:`, error);
        this.options.onTurnResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    await this.runPromise?.catch(() => undefined);
    this.runPromise = null;
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    if (!this.client) throw new Error("Client not connected");
    const result = await this.client.callTool({ name, arguments: args });
    return parseToolPayload(result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    });
  }

  private async decideAction(
    tools: Array<{ name: string; description: string; inputSchema: unknown }>,
    messages: ModelMessage[],
  ): Promise<ToolCallRequest> {
    const decision = await this.options.model.decide({
      instructions: this.options.instructions,
      tools,
      messages,
    });
    const total = decision.usage.promptTokens + decision.usage.completionTokens;
    await this.options.onUsage(total);
    return decision.toolCall;
  }

  private async run(): Promise<void> {
    if (!this.client) return;

    const listed = await this.client.listTools();
    const tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema,
    }));
    const actionTools = tools.filter((t) => t.name !== "wait" && t.name !== "see");

    while (!this.stopped) {
      // 1) wait for the game to grant a turn
      const waitResult = await this.callTool("wait", {});
      if (this.stopped) break;
      if (waitResult.isError) {
        this.options.onTurnResult({ ok: false, error: waitResult.text });
        continue;
      }

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: `It is your turn. Current view:\n${waitResult.text}\nCall exactly one action tool.`,
        },
      ];

      // 2) ask model for one action
      let action = await this.decideAction(actionTools, messages);
      if (action.name === "wait" || action.name === "see") {
        // Model ignored instructions — pick a safe fallback if possible
        const fallback = actionTools[0];
        if (!fallback) {
          this.options.onTurnResult({ ok: false, error: "No action tools available" });
          continue;
        }
        action = { name: fallback.name, arguments: {} };
      }

      let result = await this.callTool(action.name, action.arguments);
      if (!result.isError) {
        this.options.onTurnResult({ ok: true });
        continue;
      }

      const firstError = toolErrorMessage(result);
      console.warn(
        `[agent-platform] session ${this.options.sessionId} action ${action.name} failed: ${firstError}; retrying once`,
      );

      // 3) retry once — feed the error and the same view back to the model
      messages.push({
        role: "assistant",
        content: `Called ${action.name}(${JSON.stringify(action.arguments)})`,
      });
      messages.push({
        role: "tool",
        name: action.name,
        content: result.text,
        isError: true,
      });
      messages.push({
        role: "user",
        content: [
          `Action ${action.name} failed: ${firstError}`,
          "Retry once with a different legal action (or different arguments).",
          "Do not repeat the same failing call. Do not call wait or see.",
          `Current view was:\n${waitResult.text}`,
        ].join("\n"),
      });

      const retry = await this.decideAction(actionTools, messages);
      if (retry.name === "wait" || retry.name === "see") {
        this.options.onTurnResult({
          ok: false,
          error: `Retry returned ${retry.name} instead of an action (after: ${firstError})`,
        });
        continue;
      }

      result = await this.callTool(retry.name, retry.arguments);
      if (!result.isError) {
        this.options.onTurnResult({ ok: true });
        continue;
      }

      const secondError = toolErrorMessage(result);
      console.warn(
        `[agent-platform] session ${this.options.sessionId} retry ${retry.name} failed: ${secondError}`,
      );
      this.options.onTurnResult({
        ok: false,
        error: secondError,
      });
    }
  }
}

function toolErrorMessage(result: { text: string; json: unknown }): string {
  if (typeof result.json === "object" && result.json && "error" in result.json) {
    return String((result.json as { error: unknown }).error);
  }
  return result.text;
}
