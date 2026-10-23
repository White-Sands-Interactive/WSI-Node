import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentServer } from "./agent-server.js";
import { TurnTimeoutError } from "./errors.js";
import {
  createTestPlatform,
  loopEventToAgentEvent,
  SessionLoop,
  type ModelClient,
  type ToolCallRequest,
} from "./testing.js";
import type { AgentEvent, InlinePlatform, StartSessionRequest } from "./types.js";

class TinyWorld {
  x = 0;
  wood = 0;
  failOnce = true;

  see() {
    return { x: this.x, wood: this.wood };
  }

  move(dx: number) {
    this.x += dx;
    return { x: this.x };
  }

  chop() {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("axe slipped");
    }
    this.wood += 1;
    return { wood: this.wood };
  }

  bad() {
    throw new Error("always bad");
  }
}

class Gated {
  static agent = {
    actions: {
      move: { description: "Move", args: { dx: z.number() } },
    },
  };

  x = 0;

  see() {
    return { x: this.x };
  }

  move(dx: number) {
    this.x += dx;
    return { x: this.x };
  }
}

const idle: InlinePlatform = {
  async startSession() {},
  async stopSession() {},
  async close() {},
};

describe("AgentServer", () => {
  it("returns the action taken by a scripted model", async () => {
    const world = new TinyWorld();
    const events: AgentEvent[] = [];
    const agents = new AgentServer({
      inline: createTestPlatform([{ name: "move", arguments: { dx: 3 } }]),
      onEvent: (event) => events.push(event),
    });
    const agent = await agents.start(world);
    const result = await agent.turn();
    expect(result.action).toBe("move");
    expect(result.args).toEqual({ dx: 3 });
    expect(result.attempts).toBe(1);
    expect(result.usage.promptTokens).toBe(1);
    expect(world.x).toBe(3);
    expect(events.some((event) => event.type === "action" && event.action === "move")).toBe(true);
    await agents.close();
  });

  it("retries once after a rejected action", async () => {
    const world = new TinyWorld();
    const agents = new AgentServer({
      inline: createTestPlatform([
        { name: "chop", arguments: {} },
        { name: "chop", arguments: {} },
      ]),
    });
    const agent = await agents.start(world);
    const result = await agent.turn();
    expect(result.attempts).toBe(2);
    expect(result.action).toBe("chop");
    expect(world.wood).toBe(1);
    await agents.close();
  });

  it("throws TurnFailedError with both attempts", async () => {
    const world = new TinyWorld();
    const agents = new AgentServer({
      inline: createTestPlatform([
        { name: "bad", arguments: {} },
        { name: "bad", arguments: {} },
      ]),
    });
    const agent = await agents.start(world);
    await expect(agent.turn()).rejects.toMatchObject({
      name: "TurnFailedError",
      message: "always bad",
      attempts: [
        { action: "bad", error: "always bad" },
        { action: "bad", error: "always bad" },
      ],
    });
    await agents.close();
  });

  it("runs two sessions on one AgentServer", async () => {
    const a = new TinyWorld();
    const b = new TinyWorld();
    const agents = new AgentServer({
      inline: createTestPlatform([
        { name: "move", arguments: { dx: 1 } },
        { name: "move", arguments: { dx: 5 } },
      ]),
    });
    const agentA = await agents.start(a);
    const agentB = await agents.start(b);
    await agentA.turn();
    await agentB.turn();
    expect(a.x).toBe(1);
    expect(b.x).toBe(5);
    await agents.close();
  });

  it("rejects a turn that exceeds the timeout", async () => {
    const agents = new AgentServer({ inline: idle, turnTimeoutMs: 20 });
    const agent = await agents.start(new TinyWorld());
    await expect(agent.turn()).rejects.toBeInstanceOf(TurnTimeoutError);
    await agents.close();
  });

  it("passes goal and extra instructions to the platform", async () => {
    let goal = "";
    let instructions = "";
    const inline: InlinePlatform = {
      async startSession(request) {
        goal = request.goal ?? "";
        instructions = request.instructions;
      },
      async stopSession() {},
      async close() {},
    };
    const agents = new AgentServer({ inline });
    await agents.start(new TinyWorld(), { goal: "Collect wood", instructions: "Stay calm." });
    expect(goal).toBe("Collect wood");
    expect(instructions).toContain("Stay calm.");
    expect(instructions).toContain("call wait first");
    expect(instructions).toContain("done list");
    await agents.close();
  });

  it("treats a schema failure as a failed action and retries", async () => {
    const world = new Gated();
    const agents = new AgentServer({
      inline: createTestPlatform([
        { name: "move", arguments: { dx: "nope" } },
        { name: "move", arguments: { dx: 2 } },
      ]),
    });
    const agent = await agents.start(world);
    const result = await agent.turn();
    expect(result.attempts).toBe(2);
    expect(world.x).toBe(2);
    await agents.close();
  });

  it("reads the platform key from the environment", () => {
    const previous = process.env.WSI_PLATFORM_KEY;
    delete process.env.WSI_PLATFORM_KEY;
    expect(() => new AgentServer()).toThrow(/WSI_PLATFORM_KEY/);
    process.env.WSI_PLATFORM_KEY = "pk_test";
    const agents = new AgentServer({ inline: idle });
    expect(agents).toBeInstanceOf(AgentServer);
    if (previous === undefined) delete process.env.WSI_PLATFORM_KEY;
    else process.env.WSI_PLATFORM_KEY = previous;
  });

  it("shows this character's earlier actions on the next view", async () => {
    const views: string[] = [];
    const memoryPath = join(mkdtempSync(join(tmpdir(), "wsi-agent-")), "memory.sqlite");
    const agents = new AgentServer({
      memoryPath,
      inline: platformThatRecordsViews(
        [
          { name: "move", arguments: { dx: 1 } },
          { name: "move", arguments: { dx: 4 } },
        ],
        views,
      ),
    });
    const world = new TinyWorld();
    const agent = await agents.start(world, { name: "Ada" });
    await agent.turn();
    await agent.turn();
    expect(doneFromPrompt(views[0] ?? "")).toEqual([]);
    expect(doneFromPrompt(views[1] ?? "")).toEqual([{ action: "move", args: { dx: 1 }, ok: true }]);
    expect(world.x).toBe(5);
    await agents.close();
  });
});

function platformThatRecordsViews(script: ToolCallRequest[], views: string[]): InlinePlatform {
  const loops = new Map<string, SessionLoop>();
  let index = 0;
  const model: ModelClient = {
    async decide({ messages }) {
      const prompt = messages.find((message) => message.role === "user");
      if (prompt && prompt.role === "user") views.push(prompt.content);
      const call = script[index] ?? { name: "wait", arguments: {} };
      index += 1;
      return {
        toolCall: call,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };
  return {
    async startSession(request: StartSessionRequest) {
      const loop = new SessionLoop({
        sessionId: request.sessionId,
        transport: request.transport,
        instructions: request.instructions,
        ...(request.goal ? { goal: request.goal } : {}),
        model,
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
      const running = [...loops.values()];
      loops.clear();
      for (const loop of running) await loop.stop();
    },
  };
}

function doneFromPrompt(prompt: string): unknown {
  const start = prompt.indexOf("{");
  const end = prompt.lastIndexOf("}");
  const view = JSON.parse(prompt.slice(start, end + 1)) as { done?: unknown };
  return view.done;
}
