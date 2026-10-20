import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReflectedPlayer } from "./reflect.js";
import type { TurnGate } from "./turn-gate.js";

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

function zodShapeForParams(paramNames: string[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of paramNames) {
    if (/^(n|count|amount|x|y|dx|dy|index)$/i.test(name) || /Count$|Amount$/.test(name)) {
      shape[name] = z.number();
    } else {
      shape[name] = z.union([z.string(), z.number(), z.boolean()]);
    }
  }
  return shape;
}

/**
 * Build an in-process MCP server for one player session.
 * Tools: see, wait, and every public action method.
 */
export function createSessionMcpServer(
  player: ReflectedPlayer,
  gate: TurnGate,
  options?: { name?: string },
): McpServer {
  const server = new McpServer(
    { name: options?.name ?? "agent-player", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "see",
    {
      description: "Read the current game view for this player.",
    },
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
    {
      description:
        "Block until the game calls turn() for this session, then return the current see() view.",
    },
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
    const shape = zodShapeForParams(action.paramNames);
    const hasParams = action.paramNames.length > 0;
    if (hasParams) {
      server.registerTool(
        action.name,
        {
          description: `Action: ${action.name}`,
          inputSchema: shape,
        },
        async (args) => {
          try {
            const result = await action.invoke(args as Record<string, unknown>);
            return jsonResult(result ?? { ok: true });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    } else {
      server.registerTool(
        action.name,
        {
          description: `Action: ${action.name}`,
        },
        async () => {
          try {
            const result = await action.invoke({});
            return jsonResult(result ?? { ok: true });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    }
  }

  return server;
}
