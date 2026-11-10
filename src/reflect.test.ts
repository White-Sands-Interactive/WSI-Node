import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bindDynamic, getParamNames, reflectPlayer } from "./reflect.js";

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

  it("publishes a dynamic see and action, and checks arguments", async () => {
    const player = { n: 1 };
    let seen: Record<string, unknown> | undefined;
    bindDynamic(player, "see", "", undefined, () => ({ n: player.n }));
    bindDynamic(player, "add", "Add dx", { dx: z.number().int() }, (args) => {
      seen = args;
      player.n += args.dx as number;
      return { n: player.n };
    });

    const reflected = reflectPlayer(player);
    expect(reflected.see.description).toBe("Action: see");
    expect(await reflected.see.invoke({})).toEqual({ n: 1 });
    expect(reflected.actions.map((action) => action.name)).toEqual(["add"]);
    expect(reflected.tools.map((tool) => tool.name).sort()).toEqual(["add", "see", "wait"]);
    const add = reflected.actions[0]!;
    expect(add.description).toBe("Add dx");
    expect(add.descriptor.inputSchema.properties?.dx?.type).toBe("integer");
    expect(await add.invoke({ dx: 4, extra: true })).toEqual({ n: 5 });
    expect(seen).toEqual({ dx: 4 });
    await expect(add.invoke({ dx: "no" })).rejects.toThrow(/dx/);
  });

  it("replaces a dynamic tool and a reflected method with the same name", async () => {
    const player = new Sample();
    bindDynamic(player, "move", "first", undefined, () => 1);
    bindDynamic(player, "move", "", undefined, () => 2);
    const reflected = reflectPlayer(player);
    const moves = reflected.actions.filter((action) => action.name === "move");
    expect(moves).toHaveLength(1);
    expect(reflected.tools.filter((tool) => tool.name === "move")).toHaveLength(1);
    expect(moves[0]?.description).toBe("Action: move");
    expect(await moves[0]?.invoke({ dx: 9, dy: 9 })).toBe(2);
  });

  it("accepts a declared action that is only a dynamic tool", () => {
    class Scripted {
      static agent = { actions: { add: { description: "from class" } } };
    }
    const player = new Scripted();
    bindDynamic(player, "see", "Look", undefined, () => ({}));
    bindDynamic(player, "add", "Add", undefined, () => 1);
    const reflected = reflectPlayer(player);
    expect(reflected.actions.map((action) => action.name)).toEqual(["add"]);
    expect(reflected.see.description).toBe("Look");
  });

  it("rejects wait, an empty name, a private name, and a missing callback", () => {
    const player = {};
    expect(() => bindDynamic(player, "wait", "", undefined, () => null)).toThrow('cannot publish action "wait"');
    expect(() => bindDynamic(player, "", "", undefined, () => null)).toThrow('cannot publish action ""');
    expect(() => bindDynamic(player, "_hidden", "", undefined, () => null)).toThrow('cannot publish action "_hidden"');
    expect(() => bindDynamic(player, "add", "", undefined, undefined)).toThrow('cannot publish action "add"');
  });
});
