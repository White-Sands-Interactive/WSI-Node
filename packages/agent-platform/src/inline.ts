import type { InlinePlatform, StartSessionRequest } from "@wsi/agent-player";
import type { ModelClient } from "./model.js";
import { SessionLoop } from "./session-loop.js";

export type InlinePlatformOptions = {
  model: ModelClient;
  onUsage?: (tokens: number) => void | Promise<void>;
};

/**
 * In-process platform for tests and local demos.
 * Same session loop as the WebSocket server; no network.
 */
export function createInlinePlatform(options: InlinePlatformOptions): InlinePlatform {
  const loops = new Map<string, SessionLoop>();

  return {
    async startSession(request: StartSessionRequest) {
      const loop = new SessionLoop({
        sessionId: request.sessionId,
        transport: request.transport,
        instructions: request.instructions,
        model: options.model,
        onUsage: async (tokens) => {
          await options.onUsage?.(tokens);
        },
        onTurnResult: request.onTurnResult,
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
        await this.stopSession(id);
      }
    },
  };
}
