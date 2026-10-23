import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DoneAction } from "./memory.js";
import { viewWithDone } from "./memory.js";
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

export type SessionActionLog = {
  record(entry: DoneAction): void;
  done(): DoneAction[];
};

/**
 * Build an in-process MCP server for one player session.
 * Tools come from one definition: see, wait, and every public action.
 * When an action log is set, see and wait include what this character already called.
 */
export function createSessionMcpServer(
  player: ReflectedPlayer,
  gate: TurnGate,
  options?: { name?: string; actions?: SessionActionLog },
): McpServer {
  const server = new McpServer(
    { name: options?.name ?? "agent-player", version: SDK_VERSION },
    { capabilities: { tools: {} } },
  );
  const actions = options?.actions;

  const viewed = async () => {
    const view = await player.see.invoke({});
    return actions ? viewWithDone(view, actions.done()) : view;
  };

  server.registerTool(
    "see",
    { description: player.see.description },
    async () => {
      try {
        return jsonResult(await viewed());
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
        return jsonResult(await viewed());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  for (const action of player.actions) {
    const handler = async (args: Record<string, unknown>) => {
      try {
        const result = await action.invoke(args);
        actions?.record({ action: action.name, args, ok: true });
        return jsonResult(result ?? { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actions?.record({ action: action.name, args, ok: false, error: message });
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
