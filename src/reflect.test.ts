import { describe, expect, it } from "vitest";
import { z } from "zod";
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

class Typed {
  static agent = {
    description: "A typed player",
    actions: {
      move: {
        description: "Step by dx",
        args: { dx: z.number().int() },
      },
    },
  };

  see() {
    return { ok: true };
  }

  move(dx: number) {
    return dx;
  }

  wave() {
    return "hi";
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
    expect(reflected.actions.map((action) => action.name).sort()).toEqual(["chop", "move"]);
    expect(reflected.tools.map((tool) => tool.name).sort()).toEqual(["chop", "move", "see", "wait"]);
    const move = reflected.tools.find((tool) => tool.name === "move");
    expect(move?.inputSchema.required).toEqual(["dx", "dy"]);
    expect(move?.inputSchema.properties?.dx?.type).not.toBe("number");
  });

  it("invokes methods with named args", async () => {
    const reflected = reflectPlayer(new Sample());
    const move = reflected.actions.find((action) => action.name === "move")!;
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

  it("uses declared zod args and still reflects undeclared methods", async () => {
    const reflected = reflectPlayer(new Typed());
    expect(reflected.description).toBe("A typed player");
    expect(reflected.actions.map((action) => action.name).sort()).toEqual(["move", "wave"]);
    const move = reflected.tools.find((tool) => tool.name === "move");
    expect(move?.description).toBe("Step by dx");
    expect(move?.inputSchema.properties?.dx?.type).toBe("integer");
    const action = reflected.actions.find((item) => item.name === "move")!;
    await expect(action.invoke({ dx: "no" })).rejects.toThrow(/dx/);
    expect(await action.invoke({ dx: 4 })).toBe(4);
  });

  it("rejects a declared action that is not a method", () => {
    class Broken {
      static agent = { actions: { fly: { description: "nope" } } };
      see() {
        return {};
      }
    }
    expect(() => reflectPlayer(new Broken())).toThrow(/fly/);
  });
});
