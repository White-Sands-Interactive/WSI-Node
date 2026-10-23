import type { InlinePlatform, StartSessionRequest } from "../types.js";
import { createScriptedModel, type ToolCallRequest } from "./model.js";
import { loopEventToAgentEvent, SessionLoop } from "./session-loop.js";

/**
 * In-process platform that replays a script of tool calls.
 * Same session loop as production; no network and no platform key.
 */
export function createTestPlatform(script: ToolCallRequest[]): InlinePlatform {
  const model = createScriptedModel(script);
  const loops = new Map<string, SessionLoop>();

  return {
    async startSession(request: StartSessionRequest) {
      const loop = new SessionLoop({
        sessionId: request.sessionId,
        transport: request.transport,
        instructions: request.instructions,
        ...(request.goal ? { goal: request.goal } : {}),
        model,
        ...(request.logger ? { logger: request.logger } : {}),
        onUsage: async (tokens) => {
          await request.onUsage?.(tokens);
        },
        onTurnResult: request.onTurnResult,
        onEvent: (event) => {
          request.onEvent?.(loopEventToAgentEvent(request.sessionId, event));
        },
      });
      loops.set(request.sessionId, loop);
      await loop.start();
    },

    async stopSession(sessionId: string) {
      const loop = loops.get(sessionId);
      if (!loop) return;
      loops.delete(sessionId);
      await loop.stop();
    },

    async close() {
      const ids = [...loops.keys()];
      for (const id of ids) {
        const loop = loops.get(id);
        loops.delete(id);
        await loop?.stop();
      }
    },
  };
}
