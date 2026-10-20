import { describe, expect, it } from "vitest";
import { getParamNames, reflectPlayer } from "./reflect.js";

class Sample {
  see() {
    return { ok: true };
  }

  move(dx: number, dy: number) {
    return dx + dy;
  }

  chop() {
    return 1;
  }

  _hidden() {
    return "secret";
  }
}

describe("getParamNames", () => {
  it("reads parameter names from a method", () => {
    expect(getParamNames(Sample.prototype.move)).toEqual(["dx", "dy"]);
    expect(getParamNames(Sample.prototype.chop)).toEqual([]);
  });
});

describe("reflectPlayer", () => {
  it("publishes see, actions, and wait; skips _ methods", () => {
    const reflected = reflectPlayer(new Sample());
    expect(reflected.see.name).toBe("see");
    expect(reflected.actions.map((a) => a.name).sort()).toEqual(["chop", "move"]);
    expect(reflected.tools.map((t) => t.name).sort()).toEqual(["chop", "move", "see", "wait"]);
    const move = reflected.tools.find((t) => t.name === "move");
    expect(move?.inputSchema.required).toEqual(["dx", "dy"]);
  });

  it("invokes methods with named args", async () => {
    const reflected = reflectPlayer(new Sample());
    const move = reflected.actions.find((a) => a.name === "move")!;
    expect(await move.invoke({ dx: 2, dy: 3 })).toBe(5);
  });

  it("requires see()", () => {
    class NoSee {
      move() {
        return 1;
      }
    }
    expect(() => reflectPlayer(new NoSee())).toThrow(/see/);
  });
});
