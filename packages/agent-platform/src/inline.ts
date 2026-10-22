import type { InlinePlatform, StartSessionRequest } from "@whitesands/agent-player";
import { loopEventToAgentEvent, SessionLoop } from "@whitesands/agent-player/testing";
import type { Logger } from "@whitesands/agent-player";
import type { ModelClient } from "./model.js";

export type InlinePlatformOptions = {
  model: ModelClient;
  logger?: Logger;
  onUsage?: (tokens: number) => void | Promise<void>;
};

/**
 * In-process platform for the service's own tests.
 * Game code should use `createTestPlatform` from `@whitesands/agent-player/testing`.
 */
export function createInlinePlatform(options: InlinePlatformOptions): InlinePlatform {
  const loops = new Map<string, SessionLoop>();

  return {
    async startSession(request: StartSessionRequest) {
      const logger = request.logger ?? options.logger;
      const loop = new SessionLoop({
        sessionId: request.sessionId,
        transport: request.transport,
        instructions: request.instructions,
        ...(request.goal ? { goal: request.goal } : {}),
        model: options.model,
        ...(logger ? { logger } : {}),
        onUsage: async (tokens) => {
          await request.onUsage?.(tokens);
          await options.onUsage?.(tokens);
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
