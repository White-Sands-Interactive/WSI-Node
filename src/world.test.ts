import { describe, expect, it } from "vitest";
import type { AgentServer } from "./agent-server.js";
import type { AgentHandle, TurnResult } from "./types.js";
import { SessionEndedError, TurnTimeoutError } from "./errors.js";
import { World, type Body, type Position, type WorldEvent } from "./world.js";

type Tools = Record<string, (...args: unknown[]) => unknown>;

/** A stand-in AgentServer whose agents play a scripted list of tool calls, one per turn. */
function fakeServer(scripts: Record<string, [string, ...unknown[]][]>) {
  const started: Record<string, { options: Record<string, unknown>; views: Record<string, unknown>[]; observed: string[]; turns: number }> = {};
  const server = {
    async start(tools: Tools, options: Record<string, unknown>): Promise<AgentHandle> {
      const name = String(options.name);
      const record = { options, views: [] as Record<string, unknown>[], observed: [] as string[], turns: 0 };
      started[name] = record;
      return {
        sessionId: name,
        async turn(): Promise<TurnResult> {
          record.turns += 1;
          record.views.push(tools.see!() as Record<string, unknown>);
          const [action, ...args] = scripts[name]?.shift() ?? ["idle"];
          const result = tools[action]!(...args);
          return { action, args: {}, result, attempts: 1, usage: { promptTokens: 10, completionTokens: 2 } };
        },
        stop: async () => undefined,
        on: () => () => undefined,
        observe: (text: string) => void record.observed.push(text),
        relationships: () => ({}),
      };
    },
  };
  return { server: server as unknown as AgentServer, started };
}

function body(x: number, y: number): Body & { at: Position; said: string[] } {
  return {
    at: { x, y },
    said: [],
    getPosition() {
      return this.at;
    },
    async moveTo(goal: Position) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      this.at = goal;
      return true;
    },
    stop() {},
    say(text: string) {
      this.said.push(text);
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("World", () => {
  it("gives a character a view, standard actions, and turns only when something happens", async () => {
    const { server, started } = fakeServer({ Mia: [["say", "Hi Alex!", "Alex"], ["use", "stove", "cook"], ["go_to", "beach"]] });
    const world = new World(server, { name: "Test Town", idleSeconds: 600, needs: { food: { perMinute: 1, start: 40 } } });
    world.addPlace("cafe", { description: "A cafe", position: { x: 0, y: 0 } });
    world.addPlace("beach", { description: "The beach", position: { x: 200, y: 0 } });
    world.addThing("stove", { place: "cafe", position: { x: 2, y: 0 }, activities: { cook: { description: "Cook a meal", seconds: 0.1, effects: { food: 50 }, gives: "meal" } } });
    const miaBody = body(0, 0);
    const mia = await world.addCharacter({ id: "mia-id", name: "Mia", body: miaBody, home: "cafe" });
    mia.wake = null;
    let alex: Position = { x: 60, y: 0 };
    world.addPerson({ name: "Alex", getPosition: () => alex });
    const speech: string[] = [];
    world.on((event) => {
      if (event.type === "speech") speech.push(`${event.speaker}>${event.to}: ${event.text}`);
    });
    world.start();

    const options = started.Mia!.options;
    expect(options.playerId).toBe("mia-id");
    expect(options.memory).toBe(true);
    expect(options.subgoals).toBe(false);
    expect(String(options.instructions)).toContain("cafe: A cafe (your home)");

    // Out of earshot: nobody hears, nobody gets a turn.
    expect(world.say("Alex", "Anyone there?")).toBe(0);
    await wait(700);
    expect(started.Mia!.turns).toBe(0);

    // Walking up is noticed, and speaking gets an answer.
    alex = { x: 5, y: 0 };
    await wait(700);
    expect(started.Mia!.observed).toContain("Alex walked up to you.");
    world.say("Alex", "Hello!");
    await wait(900);
    expect(miaBody.said).toEqual(["Hi Alex!"]);
    expect(speech.at(-1)).toBe("Mia>Alex: Hi Alex!");
    const view = started.Mia!.views[0]!;
    expect((view.you as { at: string }).at).toBe("cafe");
    expect(view.why_you_are_acting_now).toContain('Alex said to you: "Hello!"');
    expect((view.people_nearby as { name: string; who: string }[])[0]).toMatchObject({ name: "Alex", who: "player" });
    expect((view.things_here as { thing: string }[])[0]!.thing).toBe("stove");

    // The next turn cooks; finishing is a new reason to act, and that turn walks to the beach.
    mia.notice("test: act again", { urgent: true });
    await wait(1200);
    expect(mia.carrying).toContain("meal");
    expect(mia.needs.food).toBeGreaterThan(85);
    await wait(4000);
    expect(mia.place()).toBe("beach");
    world.stop();
  }, 15_000);

  it("starts a new session when the platform ends one, or after turns keep timing out", async () => {
    for (const failure of [
      () => new SessionEndedError("The platform ended this session: model request failed"),
      () => new TurnTimeoutError("turn() timed out after 10ms"),
    ]) {
      const starts: string[] = [];
      let stops = 0;
      const server = {
        async start(tools: Tools, options: Record<string, unknown>): Promise<AgentHandle> {
          const generation = starts.length;
          starts.push(String(options.playerId));
          return {
            sessionId: `s${generation}`,
            async turn(): Promise<TurnResult> {
              if (generation === 0) throw failure();
              tools.see!();
              return { action: "idle", args: {}, result: tools.idle!(), attempts: 1, usage: { promptTokens: 1, completionTokens: 1 } };
            },
            stop: async () => {
              stops += 1;
            },
            on: () => () => undefined,
            observe: () => undefined,
            relationships: () => ({}),
          };
        },
      } as unknown as AgentServer;
      const world = new World(server, { name: "Test Town", idleSeconds: 0.01, turnsPerMinute: 6000 });
      world.addPlace("cafe", { description: "A cafe", position: { x: 0, y: 0 } });
      const events: WorldEvent[] = [];
      world.on((event) => void events.push(event));
      const mia = await world.addCharacter({ id: "5a4d7000-0000-4000-8000-0000000000b1", name: "Mia", body: body(0, 0) });
      world.start();
      const deadline = Date.now() + 8_000;
      while (!events.some((event) => event.type === "turn" && event.ok) && Date.now() < deadline) {
        mia.wakeIn(0);
        await wait(20);
      }
      world.stop();
      expect(events.some((event) => event.type === "restarted" && event.character === "Mia")).toBe(true);
      expect(events.some((event) => event.type === "turn" && event.ok)).toBe(true);
      expect(starts).toEqual(["5a4d7000-0000-4000-8000-0000000000b1", "5a4d7000-0000-4000-8000-0000000000b1"]);
      expect(stops).toBe(1);
      expect(mia.agent.sessionId).toBe("s1");
    }
  }, 20_000);

  it("pause stops turns and resume opens a new session", async () => {
    let starts = 0;
    let stops = 0;
    let turns = 0;
    const server = {
      async start(): Promise<AgentHandle> {
        starts += 1;
        return {
          sessionId: `s${starts}`,
          async turn(): Promise<TurnResult> {
            turns += 1;
            return { action: "idle", args: {}, result: { ok: true }, attempts: 1, usage: { promptTokens: 1, completionTokens: 1 } };
          },
          stop: async () => {
            stops += 1;
          },
          on: () => () => undefined,
          observe: () => undefined,
          relationships: () => ({}),
        };
      },
    } as unknown as AgentServer;
    const world = new World(server, { name: "Test Town", idleSeconds: 0.01, turnsPerMinute: 6000 });
    const mia = await world.addCharacter({ id: "5a4d7000-0000-4000-8000-0000000000b1", name: "Mia", body: body(0, 0) });
    mia.wake = 0;
    world.start();
    const deadline = Date.now() + 3_000;
    while (turns < 1 && Date.now() < deadline) await wait(20);
    expect(turns).toBeGreaterThan(0);
    await world.pause();
    const pausedTurns = turns;
    await wait(400);
    expect(turns).toBe(pausedTurns);
    expect(stops).toBe(1);
    expect(starts).toBe(1);
    await world.resume();
    expect(starts).toBe(2);
    const resumed = Date.now() + 3_000;
    while (turns === pausedTurns && Date.now() < resumed) await wait(20);
    world.stop();
    expect(turns).toBeGreaterThan(pausedTurns);
  }, 10_000);
});
