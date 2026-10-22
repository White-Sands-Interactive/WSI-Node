import { describe, expect, it } from "vitest";
import { AgentServer } from "@whitesands/agent-player";
import { createInlinePlatform } from "./inline.js";
import { createScriptedModel } from "./model.js";

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

describe("session loop", () => {
  it("wait + turn runs a scripted action", async () => {
    const world = new TinyWorld();
    const model = createScriptedModel([{ name: "move", arguments: { dx: 3 } }]);
    const agents = new AgentServer({
      platformKey: "test",
      inline: createInlinePlatform({ model }),
    });
    const agent = await agents.start(world);
    await agent.turn();
    expect(world.x).toBe(3);
    await agent.stop();
    await agents.close();
  });

  it("retries once after a rejected action", async () => {
    const world = new TinyWorld();
    const model = createScriptedModel([
      { name: "chop", arguments: {} }, // fails
      { name: "chop", arguments: {} }, // succeeds
    ]);
    const agents = new AgentServer({
      platformKey: "test",
      inline: createInlinePlatform({ model }),
    });
    const agent = await agents.start(world);
    await agent.turn();
    expect(world.wood).toBe(1);
    await agent.stop();
    await agents.close();
  });

  it("surfaces the second failure to turn()", async () => {
    const world = new TinyWorld();
    const model = createScriptedModel([
      { name: "bad", arguments: {} },
      { name: "bad", arguments: {} },
    ]);
    const agents = new AgentServer({
      platformKey: "test",
      inline: createInlinePlatform({ model }),
    });
    const agent = await agents.start(world);
    await expect(agent.turn()).rejects.toThrow(/always bad/);
    await agent.stop();
    await agents.close();
  });

  it("supports two sessions on one AgentServer", async () => {
    const a = new TinyWorld();
    const b = new TinyWorld();
    const model = createScriptedModel([
      { name: "move", arguments: { dx: 1 } },
      { name: "move", arguments: { dx: 5 } },
    ]);
    const agents = new AgentServer({
      platformKey: "test",
      inline: createInlinePlatform({ model }),
    });
    const agentA = await agents.start(a);
    const agentB = await agents.start(b);
    await agentA.turn();
    await agentB.turn();
    expect(a.x).toBe(1);
    expect(b.x).toBe(5);
    await agents.close();
  });
});
