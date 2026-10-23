import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../logger.js";
import { log } from "../logger.js";
import type { AgentEvent } from "../types.js";
import type { AttemptRecord, SessionEventName, TokenUsage, TurnReport } from "../protocol.js";
import { SDK_VERSION } from "../protocol.js";
import type { ModelClient, ModelMessage, ToolCallRequest } from "./model.js";

export type LoopEvent = {
  event: SessionEventName;
  action?: string;
  args?: Record<string, unknown>;
  error?: string;
};

export function loopEventToAgentEvent(sessionId: string, event: LoopEvent): AgentEvent {
  if (event.event === "action") {
    return {
      type: "action",
      sessionId,
      action: event.action ?? "unknown",
      args: event.args ?? {},
    };
  }
  if (event.event === "retry") {
    return {
      type: "retry",
      sessionId,
      action: event.action ?? "unknown",
      args: event.args ?? {},
      error: event.error ?? "action failed",
    };
  }
  return {
    type: "turnFailed",
    sessionId,
    error: event.error ?? "turn failed",
    ...(event.action ? { action: event.action } : {}),
    ...(event.args ? { args: event.args } : {}),
  };
}

export type SessionLoopOptions = {
  sessionId: string;
  transport: Transport;
  instructions: string;
  goal?: string;
  model: ModelClient;
  logger?: Logger;
  onUsage: (tokens: number) => void | Promise<void>;
  onTurnResult: (result: TurnReport) => void;
  onEvent?: (event: LoopEvent) => void;
};

type ToolPayload = { isError: boolean; text: string; json: unknown };

function parseToolPayload(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): ToolPayload {
  const text = result.content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text!)
    .join("\n");
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep text
  }
  return { isError: Boolean(result.isError), text, json };
}

function toolErrorMessage(result: ToolPayload): string {
  if (typeof result.json === "object" && result.json && "error" in result.json) {
    return String((result.json as { error: unknown }).error);
  }
  return result.text;
}

function composeInstructions(instructions: string, goal?: string): string {
  if (!goal) return instructions;
  return `${instructions}\n\nYour goal: ${goal}`;
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
    const client = new Client({ name: "agent-player", version: SDK_VERSION });
    await client.connect(this.options.transport);
    this.client = client;
    this.runPromise = this.run().catch((error) => {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      log(this.options.logger, "error", `session ${this.options.sessionId} crashed: ${message}`);
      this.options.onTurnResult({ ok: false, error: message, attempts: 0 });
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

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
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
    usage: TokenUsage,
  ): Promise<ToolCallRequest> {
    const decision = await this.options.model.decide({
      instructions: composeInstructions(this.options.instructions, this.options.goal),
      tools,
      messages,
    });
    usage.promptTokens += decision.usage.promptTokens;
    usage.completionTokens += decision.usage.completionTokens;
    const total = decision.usage.promptTokens + decision.usage.completionTokens;
    await this.options.onUsage(total);
    return decision.toolCall;
  }

  private emit(event: LoopEvent): void {
    this.options.onEvent?.(event);
  }

  private async run(): Promise<void> {
    if (!this.client) return;

    const listed = await this.client.listTools();
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
    }));
    const actionTools = tools.filter((tool) => tool.name !== "wait" && tool.name !== "see");

    while (!this.stopped) {
      const waitResult = await this.callTool("wait", {});
      if (this.stopped) break;
      if (waitResult.isError) {
        this.options.onTurnResult({ ok: false, error: waitResult.text, attempts: 0 });
        continue;
      }

      const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
      const attemptDetails: AttemptRecord[] = [];
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: `It is your turn. Current view:\n${waitResult.text}\nCall exactly one action tool.`,
        },
      ];

      let action = await this.decideAction(actionTools, messages, usage);
      let result: ToolPayload | undefined;
      let firstError: string;
      if (action.name === "wait" || action.name === "see") {
        // wait and see are how the loop reads state. They are not a move.
        firstError = `${action.name} is not an action`;
      } else {
        this.emit({ event: "action", action: action.name, args: action.arguments });
        result = await this.callTool(action.name, action.arguments);
        if (!result.isError) {
          this.options.onTurnResult({
            ok: true,
            action: action.name,
            args: action.arguments,
            result: result.json,
            attempts: 1,
            usage,
          });
          continue;
        }
        firstError = toolErrorMessage(result);
      }
      attemptDetails.push({ action: action.name, args: action.arguments, error: firstError });
      log(this.options.logger, "warn", `session ${this.options.sessionId} action ${action.name} failed: ${firstError}; retrying once`);
      this.emit({ event: "retry", action: action.name, args: action.arguments, error: firstError });

      messages.push({
        role: "assistant",
        content: `Called ${action.name}(${JSON.stringify(action.arguments)})`,
      });
      messages.push({
        role: "tool",
        name: action.name,
        content: result?.text ?? firstError,
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

      const retry = await this.decideAction(actionTools, messages, usage);
      if (retry.name === "wait" || retry.name === "see") {
        const error = `Retry returned ${retry.name} instead of an action (after: ${firstError})`;
        this.emit({ event: "turnFailed", error });
        this.options.onTurnResult({
          ok: false,
          error,
          attempts: 1,
          attemptDetails,
          usage,
        });
        continue;
      }

      this.emit({ event: "action", action: retry.name, args: retry.arguments });
      result = await this.callTool(retry.name, retry.arguments);
      if (!result.isError) {
        this.options.onTurnResult({
          ok: true,
          action: retry.name,
          args: retry.arguments,
          result: result.json,
          attempts: 2,
          usage,
        });
        continue;
      }

      const secondError = toolErrorMessage(result);
      attemptDetails.push({ action: retry.name, args: retry.arguments, error: secondError });
      log(this.options.logger, "warn", `session ${this.options.sessionId} retry ${retry.name} failed: ${secondError}`);
      this.emit({ event: "turnFailed", action: retry.name, args: retry.arguments, error: secondError });
      this.options.onTurnResult({
        ok: false,
        error: secondError,
        attempts: 2,
        attemptDetails,
        usage,
      });
    }
  }
}
