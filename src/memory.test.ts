import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionMemory, viewWithDone } from "./memory.js";

describe("SessionMemory", () => {
  it("returns one session's actions oldest first", () => {
    const memory = new SessionMemory(join(mkdtempSync(join(tmpdir(), "wsi-memory-")), "memory.sqlite"));
    memory.record("ada", "Ada", { action: "cross", args: { passenger: "goat" }, ok: true });
    memory.record("ada", "Ada", { action: "cross", args: { passenger: "wolf" }, ok: false, error: "wrong bank" });
    memory.record("bea", "Bea", { action: "move", args: { dx: 1 }, ok: true });

    expect(memory.done("ada")).toEqual([
      { action: "cross", args: { passenger: "goat" }, ok: true },
      { action: "cross", args: { passenger: "wolf" }, ok: false, error: "wrong bank" },
    ]);
    expect(memory.done("bea")).toEqual([{ action: "move", args: { dx: 1 }, ok: true }]);
    memory.close();
  });

  it("keeps the most recent actions on the view", () => {
    const memory = new SessionMemory(join(mkdtempSync(join(tmpdir(), "wsi-memory-")), "memory.sqlite"));
    for (let i = 0; i < 55; i += 1) {
      memory.record("ada", "Ada", { action: "move", args: { dx: i }, ok: true });
    }
    const done = memory.done("ada");
    expect(done).toHaveLength(50);
    expect(done[0]?.args).toEqual({ dx: 5 });
    expect(done[49]?.args).toEqual({ dx: 54 });
    memory.close();
  });

  it("adds done onto an object view", () => {
    expect(viewWithDone({ boat: "near" }, [])).toEqual({ boat: "near", done: [] });
    expect(viewWithDone("plain", [])).toEqual({ view: "plain", done: [] });
  });
});
