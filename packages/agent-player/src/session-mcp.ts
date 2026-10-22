import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReflectedPlayer } from "./reflect.js";
import { WAIT_DESCRIPTION } from "./reflect.js";
import type { TurnGate } from "./turn-gate.js";
import { SDK_VERSION } from "./protocol.js";

function jsonResult(payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult({ error: message }, true);
}

/**
 * Build an in-process MCP server for one player session.
 * Tools come from one definition: see, wait, and every public action.
 */
export function createSessionMcpServer(
  player: ReflectedPlayer,
  gate: TurnGate,
  options?: { name?: string },
): McpServer {
  const server = new McpServer(
    { name: options?.name ?? "agent-player", version: SDK_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "see",
    { description: player.see.description },
    async () => {
      try {
        const view = await player.see.invoke({});
        return jsonResult(view);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "wait",
    { description: WAIT_DESCRIPTION },
    async () => {
      try {
        await gate.waitForTurn();
        const view = await player.see.invoke({});
        return jsonResult(view);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  for (const action of player.actions) {
    const handler = async (args: Record<string, unknown>) => {
      try {
        const result = await action.invoke(args);
        return jsonResult(result ?? { ok: true });
      } catch (error) {
        return toolError(error);
      }
    };

    if (action.argsSchema) {
      server.registerTool(
        action.name,
        {
          description: action.description,
          inputSchema: action.argsSchema.shape,
        },
        async (args) => handler(args as Record<string, unknown>),
      );
    } else {
      server.registerTool(
        action.name,
        { description: action.description },
        async () => handler({}),
      );
    }
  }

  return server;
}
