import { describe, expect, it } from "vitest";
import { AgentServer } from "@whitesands/agent-player";
import { createInlinePlatform } from "./inline.js";
import { createScriptedModel } from "./model.js";

class Forest {
  tiles = new Map<string, string>([["2,2", "T"]]);
  treesLeft() {
    return [...this.tiles.values()].filter((t) => t === "T").length;
  }
  get(x: number, y: number) {
    return this.tiles.get(`${x},${y}`) ?? ".";
  }
  set(x: number, y: number, tile: string) {
    this.tiles.set(`${x},${y}`, tile);
  }
}

class Villager {
  wood = 0;
  constructor(
    private world: Forest,
    public name: string,
    public x: number,
    public y: number,
  ) {}

  see() {
    return {
      name: this.name,
      x: this.x,
      y: this.y,
      wood: this.wood,
      tile: this.world.get(this.x, this.y),
      treesLeft: this.world.treesLeft(),
    };
  }

  move(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    return { x: this.x, y: this.y };
  }

  chop() {
    if (this.world.get(this.x, this.y) !== "T") throw new Error("no tree");
    this.world.set(this.x, this.y, ".");
    this.wood += 1;
    return { wood: this.wood };
  }
}

describe("forest proof", () => {
  it("moves then chops; tile and wood change", async () => {
    const world = new Forest();
    const ada = new Villager(world, "Ada", 0, 2);
    const bea = new Villager(world, "Bea", 4, 4);

    const model = createScriptedModel([
      { name: "move", arguments: { dx: 2, dy: 0 } },
      { name: "chop", arguments: {} },
      { name: "move", arguments: { dx: -1, dy: 0 } },
    ]);

    const agents = new AgentServer({
      platformKey: "test",
      inline: createInlinePlatform({ model }),
    });

    const adaAgent = await agents.start(ada);
    const beaAgent = await agents.start(bea);

    expect(world.get(2, 2)).toBe("T");
    expect(ada.wood).toBe(0);

    await adaAgent.turn();
    expect(ada.x).toBe(2);
    expect(ada.y).toBe(2);

    await adaAgent.turn();
    expect(ada.wood).toBe(1);
    expect(world.get(2, 2)).toBe(".");
    expect(world.treesLeft()).toBe(0);

    await beaAgent.turn();
    expect(bea.x).toBe(3);

    await agents.close();
  });
});
