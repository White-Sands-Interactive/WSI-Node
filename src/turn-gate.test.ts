import { describe, expect, it } from "vitest";
import { TurnGate } from "./turn-gate.js";

describe("TurnGate", () => {
  it("pairs wait with turn", async () => {
    const gate = new TurnGate();
    const events: string[] = [];

    const waiting = gate.waitForTurn().then(() => {
      events.push("wait-released");
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    const turning = gate.runTurn().then((outcome) => {
      events.push(`turn-${outcome.ok ? "ok" : "fail"}`);
      return outcome;
    });

    await waiting;
    expect(events).toEqual(["wait-released"]);

    gate.completeTurn({ ok: true });
    await turning;
    expect(events).toEqual(["wait-released", "turn-ok"]);
  });
});
