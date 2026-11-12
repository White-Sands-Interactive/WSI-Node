/**
 * World: a living world on top of the agent player.
 *
 * A game describes its world once: places, things characters can use, and the
 * characters themselves. World turns that into what each character sees and
 * can do, decides when a character needs a turn, and carries speech and
 * events between characters and human players. The game does not write a view
 * or an action per character. Who a character is comes from its story in the
 * White Sands web app.
 *
 * This is the TypeScript port of WSI.World in the Luau SDK. It uses no engine
 * API: a body is any object with getPosition, moveTo, stop and say.
 */
import { z } from "zod";
import type { AgentServer } from "./agent-server.js";
import type { AgentMetadata } from "./reflect.js";
import type { AgentHandle, TurnResult } from "./types.js";

export type Position = { x: number; y: number; z?: number };

export type Body = {
  getPosition(): Position;
  /** Walk to a position. Resolves true on arrival, false if interrupted or unreachable. */
  moveTo(goal: Position): Promise<boolean>;
  stop(): void;
  /** Show a spoken line. May return the text as shown, when the game filters it. */
  say(text: string, towards?: Position): string | void;
  emote?(name: string): void;
  face?(position: Position): void;
  setStatus?(status: string | null): void;
  emotes?: string[];
};

export type Activity = {
  description: string;
  /** How long it takes. Default 5. */
  seconds?: number;
  /** Shown while it runs, such as "making coffee". Defaults to the activity name. */
  status?: string;
  /** Change to the character's needs when it finishes, such as { food: 40 }. */
  effects?: Record<string, number>;
  /** An item the character carries afterwards. */
  gives?: string;
  /** An item the character must carry. It is used up. */
  needs?: string;
  /** Emote played while it runs. */
  emote?: string;
};

export type WorldOptions = {
  name: string;
  /** One or two sentences about the world, for every character. */
  about?: string;
  /** Extra rules of the game, in plain words. */
  rules?: string;
  /** The time of day as text, such as "Tuesday 14:30, afternoon". */
  clock?: () => string;
  /** How far speech carries, and how far a character sees. Defaults 35 and 80. */
  hearing?: number;
  sight?: number;
  /** A character with nothing to react to gets a turn about this often, in seconds. Default 45. */
  idleSeconds?: number;
  /** Idle turns are this many times rarer when no human is within activeRadius. Defaults 3 and 120. */
  farSlowdown?: number;
  activeRadius?: number;
  /** A character no human can see waits this long before a turn for something it did itself. Default 20. */
  farDelay?: number;
  /** A human who comes this close is noticed. Default 12. 0 turns it off. */
  greetDistance?: number;
  /** Cap on turns per minute for the whole world. Default 30. */
  turnsPerMinute?: number;
  /** Actions per turn, 1 to 4. Default 3. */
  maxActions?: number;
  /** Needs every character has. 100 is satisfied, 0 is desperate. perMinute is how fast it falls. */
  needs?: Record<string, { perMinute: number; start?: number }>;
  /** Each character replies at most chatReplies times per chatPause seconds to another character. Defaults 2 and 90. */
  chatReplies?: number;
  chatPause?: number;
  /** Keep memory and relationships on the platform. Default true. */
  memory?: boolean;
  /** Receives warnings. */
  warn?: (message: string) => void;
};

export type WorldEvent =
  | { type: "speech"; speaker: string; text: string; to?: string }
  | { type: "status"; character: string; status: string | null }
  | { type: "relationship"; character: string; about: string; affinity: number; label: string; change: number; because: string }
  | { type: "memory"; character: string; about: string; note: string }
  | { type: "action"; character: string; action: string; args: Record<string, unknown> }
  | { type: "thinking"; character: string; on: boolean }
  | { type: "give"; from: string; to: string; item: string }
  | { type: "emote"; character: string; emote: string }
  | { type: "turn"; character: string; ok: boolean; result?: TurnResult; error?: string };

type Place = { name: string; description: string; position: Position; radius: number };
type Thing = { id: string; name: string; place?: string; position: Position; activities: Record<string, Activity>; usedBy: string | null };
type Person = { name: string; getPosition: () => Position | null; carrying: string[] };
type NoticeOptions = { about?: string; turn?: boolean; urgent?: boolean };

const DEFAULT_EMOTES = ["wave", "laugh", "cheer", "dance", "point", "shrug"];

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

const now = () => performance.now() / 1000;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** The tools one character serves to the platform. Method names are the tool names. */
class CharacterTools {
  static agent: AgentMetadata = {
    actions: {
      say: {
        description: "Say one or two short sentences out loud. Set to when you are talking to one person.",
        args: {
          text: z.string().describe("What you say, in your own voice."),
          to: z.string().describe("Name of the person you are talking to. Empty to talk to everyone near you."),
        },
      },
      go_to: {
        description: "Walk to a place. You are told when you arrive.",
        args: { place: z.string().describe("One of the places you know.") },
      },
      approach: {
        description: "Walk up to someone you can see, to talk or do something together.",
        args: { person: z.string() },
      },
      use: {
        description: "Do an activity with a thing listed in things_here. You walk to it first. You are told when you finish.",
        args: { thing: z.string(), activity: z.string() },
      },
      give: {
        description: "Give something you are carrying to someone next to you.",
        args: { item: z.string(), to: z.string() },
      },
      emote: {
        description: "Show a feeling with your body.",
        args: { emote: z.string().describe("wave, laugh, cheer, dance, point or shrug.") },
      },
      idle: { description: "Do nothing new for now and carry on as you are." },
    },
  };

  constructor(private readonly character: Character) {}

  see() {
    return this.character.view();
  }
  say(text: string, to: string) {
    return this.character.doSay(text, to);
  }
  go_to(place: string) {
    return this.character.doGoTo(place);
  }
  approach(person: string) {
    return this.character.doApproach(person);
  }
  use(thing: string, activity: string) {
    return this.character.doUse(thing, activity);
  }
  give(item: string, to: string) {
    return this.character.doGive(item, to);
  }
  emote(emote: string) {
    return this.character.doEmote(emote);
  }
  idle() {
    return { ok: true };
  }
}

export class Character {
  readonly kind = "resident";
  status: string | null = null;
  carrying: string[];
  needs: Record<string, number> = {};
  turns = 0;
  tokens = 0;
  agent!: AgentHandle;
  /** @internal */ inbox: string[] = [];
  /** @internal */ wake: number | null = now() + 2 + Math.random() * 6;
  /** @internal */ busy = false;
  /** @internal */ greeted = new Map<string, number>();
  /** @internal */ needWarned = new Set<string>();
  private task = 0;
  private using: Thing | null = null;
  private chat = { count: 0, resetAt: 0 };

  constructor(
    readonly world: World,
    readonly name: string,
    readonly body: Body,
    readonly home: string | undefined,
    carrying: string[],
  ) {
    this.carrying = [...carrying];
  }

  position(): Position {
    return this.body.getPosition();
  }

  place(): string | null {
    return this.world.placeAt(this.position());
  }

  setStatus(status: string | null): void {
    this.status = status;
    this.body.setStatus?.(status);
    this.world.emit({ type: "status", character: this.name, status });
  }

  /**
   * Tell this character something happened. It goes into its memory and its
   * next view. turn asks for a turn; urgent asks for one now.
   */
  notice(text: string, options: NoticeOptions = {}): void {
    this.inbox.push(text);
    while (this.inbox.length > 12) this.inbox.shift();
    this.agent?.observe(text, options.about);
    if (options.urgent) {
      this.wakeIn(0.2);
    } else if (options.turn) {
      // Nobody is watching a character far from every human, so its
      // follow-up turns (arrived, finished an activity) can wait.
      const world = this.world;
      const far = world.farDelay > 0 && !world.humanNear(this.position(), world.activeRadius);
      this.wakeIn(far ? world.farDelay : 2.5);
    }
  }

  /** @internal */
  wakeIn(seconds: number): void {
    const at = now() + seconds;
    if (this.wake === null || at < this.wake) this.wake = at;
  }

  /** How this character feels about someone, from the platform. */
  feelingFor(name: string): { affinity: number; label: string; note?: string } {
    const relationship = this.agent?.relationships()[name.toLowerCase()];
    return relationship
      ? { affinity: relationship.affinity, label: relationship.label, ...(relationship.note ? { note: relationship.note } : {}) }
      : { affinity: 0, label: "stranger" };
  }

  /** @internal Returns true when another character's line should get a reply. */
  mayReplyToCharacter(): boolean {
    if (now() > this.chat.resetAt) {
      this.chat.count = 0;
      this.chat.resetAt = now() + this.world.chatPause;
    }
    this.chat.count += 1;
    return this.chat.count <= this.world.chatReplies;
  }

  /** @internal */
  view(): Record<string, unknown> {
    const world = this.world;
    const here = this.position();
    const place = world.placeAt(here);
    const why = this.inbox.length > 0 ? this.inbox : ["Nothing new has happened. Carry on with your day."];
    this.inbox = [];

    const nearby: Record<string, unknown>[] = [];
    const add = (name: string, who: string, at: Position | null, doing: string | null) => {
      if (!at) return;
      const d = distance(at, here);
      if (d > world.sight) return;
      nearby.push({
        name,
        who,
        steps_away: Math.round(d),
        can_hear_you: d <= world.hearing,
        ...(doing ? { doing } : {}),
        you_feel: this.feelingFor(name).label,
      });
    };
    for (const other of world.characters.values()) {
      if (other !== this) add(other.name, "resident", other.position(), other.status);
    }
    for (const person of world.people.values()) add(person.name, "player", person.getPosition(), null);
    nearby.sort((a, b) => (a.steps_away as number) - (b.steps_away as number));

    const things: Record<string, unknown>[] = [];
    for (const thing of world.things.values()) {
      if (things.length >= 12) break;
      if (!((place && thing.place === place) || distance(thing.position, here) <= 30)) continue;
      const activities = Object.entries(thing.activities)
        .map(([name, activity]) => `${name}: ${activity.description}${activity.needs ? ` (needs ${activity.needs})` : ""}`)
        .sort();
      things.push({
        thing: thing.id,
        activities,
        ...(thing.usedBy && thing.usedBy !== this.name ? { in_use_by: thing.usedBy } : {}),
      });
    }

    const needs = Object.fromEntries(Object.entries(this.needs).map(([need, value]) => [need, Math.floor(value)]));
    return {
      ...(world.clock ? { time: world.clock() } : {}),
      why_you_are_acting_now: why,
      you: {
        at: place ?? "outdoors, between places",
        doing: this.status ?? "nothing in particular",
        ...(Object.keys(needs).length > 0 ? { needs } : {}),
        ...(this.carrying.length > 0 ? { carrying: this.carrying } : {}),
      },
      people_nearby: nearby.slice(0, 8),
      things_here: things,
    };
  }

  // Stop whatever the body is doing so a new movement can start.
  private interrupt(): number {
    this.task += 1;
    if (this.using) {
      this.using.usedBy = null;
      this.using = null;
    }
    this.body.stop();
    return this.task;
  }

  private async walk(token: number, goal: Position, status: string): Promise<boolean> {
    this.setStatus(status);
    const reached = await this.body.moveTo(goal);
    if (this.task !== token) return false;
    this.setStatus(null);
    return reached;
  }

  /** @internal */
  doSay(rawText: string, to: string) {
    let text = clip(String(rawText ?? "").trim(), 240);
    if (!text) throw new Error("say needs some text");
    const world = this.world;
    const target = world.resolve(to);
    const towards = target ? world.positionOf(target) : null;
    const shown = this.body.say(text, towards ?? undefined);
    if (typeof shown === "string" && shown) text = shown;
    const heard = world.speech(this.name, text, target);
    return heard === 0 ? { said: text, note: "Nobody was close enough to hear you." } : { said: text };
  }

  /** @internal */
  doGoTo(placeName: string) {
    const place = this.world.places.get(placeName);
    if (!place) throw new Error(`no such place: ${placeName}. Places: ${[...this.world.places.keys()].join(", ")}`);
    if (this.place() === placeName && !this.status) throw new Error(`you are already at ${placeName}`);
    const token = this.interrupt();
    void this.walk(token, place.position, `walking to ${placeName}`).then((reached) => {
      if (reached) this.notice(`You arrived at ${placeName}.`, { turn: true });
      else if (this.task === token) this.notice(`You could not get to ${placeName}.`, { turn: true });
    });
    return { walking_to: placeName };
  }

  /** @internal */
  doApproach(person: string) {
    const world = this.world;
    const name = world.resolve(person);
    const at = name ? world.positionOf(name) : null;
    if (!name || !at || name === this.name) throw new Error(`you cannot see anyone called ${person}`);
    const gap = distance(at, this.position());
    if (gap > world.sight) throw new Error(`${name} is too far away to see`);
    if (gap <= 7) return { note: `You are already next to ${name}.` };
    const token = this.interrupt();
    const here = this.position();
    const goal = { x: at.x + ((here.x - at.x) / gap) * 4, y: at.y + ((here.y - at.y) / gap) * 4 };
    void this.walk(token, goal, `walking over to ${name}`).then((reached) => {
      if (reached) this.notice(`You walked up to ${name}.`, { turn: true });
    });
    return { walking_to: name };
  }

  /** @internal */
  doUse(thingId: string, activityName: string) {
    const thing = this.world.things.get(thingId);
    if (!thing) throw new Error(`there is no thing called ${thingId}`);
    const activity = thing.activities[activityName];
    if (!activity) {
      throw new Error(`${thingId} has no activity ${activityName}. It has: ${Object.keys(thing.activities).sort().join(", ")}`);
    }
    if (thing.usedBy && thing.usedBy !== this.name) throw new Error(`${thing.usedBy} is using ${thingId} right now`);
    if (activity.needs && !this.carrying.includes(activity.needs)) throw new Error(`you need ${activity.needs} to do that`);
    const token = this.interrupt();
    const seconds = activity.seconds ?? 5;
    thing.usedBy = this.name;
    this.using = thing;
    void (async () => {
      if (distance(thing.position, this.position()) > 6 && !(await this.walk(token, thing.position, `walking to ${thing.name}`))) {
        if (this.task === token) {
          thing.usedBy = null;
          this.using = null;
          this.notice(`You could not reach ${thingId}.`, { turn: true });
        }
        return;
      }
      this.body.face?.(thing.position);
      this.setStatus(activity.status ?? activityName.replaceAll("_", " "));
      if (activity.emote) this.body.emote?.(activity.emote);
      await sleep(seconds);
      if (this.task !== token) return;
      thing.usedBy = null;
      this.using = null;
      this.setStatus(null);
      const outcome: string[] = [];
      if (activity.needs) {
        const index = this.carrying.indexOf(activity.needs);
        if (index >= 0) this.carrying.splice(index, 1);
      }
      for (const [need, change] of Object.entries(activity.effects ?? {})) {
        const current = this.needs[need];
        if (current === undefined) continue;
        this.needs[need] = Math.min(100, Math.max(0, current + change));
        outcome.push(`${need} is now ${Math.floor(this.needs[need])}`);
      }
      if (activity.gives) {
        this.carrying.push(activity.gives);
        outcome.push(`you now carry ${activity.gives}`);
      }
      const summary = outcome.length > 0 ? ` (${outcome.join(", ")})` : "";
      this.notice(`You finished: ${activityName.replaceAll("_", " ")} at ${thing.name}${summary}.`, { turn: true });
    })();
    return { started: activityName, takes_seconds: seconds };
  }

  /** @internal */
  doGive(item: string, to: string) {
    const world = this.world;
    const index = this.carrying.indexOf(item);
    if (index < 0) throw new Error(`you are not carrying ${item}`);
    const name = world.resolve(to);
    const at = name ? world.positionOf(name) : null;
    if (!name || !at) throw new Error(`you cannot see anyone called ${to}`);
    if (distance(at, this.position()) > 12) throw new Error(`${name} is too far away. Use approach first.`);
    this.carrying.splice(index, 1);
    const other = world.characters.get(name);
    if (other) {
      other.carrying.push(item);
      other.notice(`${this.name} gave you ${item}.`, { about: this.name, urgent: true });
    } else {
      world.people.get(name)?.carrying.push(item);
    }
    world.emit({ type: "give", from: this.name, to: name, item });
    return { gave: item, to: name };
  }

  /** @internal */
  doEmote(name: string) {
    const emotes = this.body.emotes ?? DEFAULT_EMOTES;
    if (!emotes.includes(name)) throw new Error(`no such emote. Choose one of: ${emotes.join(", ")}`);
    this.body.emote?.(name);
    this.world.emit({ type: "emote", character: this.name, emote: name });
    return { did: name };
  }
}

export class World {
  readonly name: string;
  readonly about: string;
  readonly rules: string;
  readonly clock: (() => string) | undefined;
  readonly hearing: number;
  readonly sight: number;
  readonly idleSeconds: number;
  readonly farSlowdown: number;
  readonly activeRadius: number;
  readonly farDelay: number;
  readonly greetDistance: number;
  readonly turnsPerMinute: number;
  readonly maxActions: number;
  readonly chatReplies: number;
  readonly chatPause: number;
  readonly places = new Map<string, Place>();
  readonly things = new Map<string, Thing>();
  readonly characters = new Map<string, Character>();
  readonly people = new Map<string, Person>();
  turnsUsed = 0;
  private readonly needDefs: Record<string, { perMinute: number; start?: number }>;
  private readonly memory: boolean;
  private readonly warn: (message: string) => void;
  private readonly listeners = new Set<(event: WorldEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private budget = 0;
  private budgetAt = now();
  private lastTick = now();

  constructor(private readonly server: AgentServer, options: WorldOptions) {
    this.name = options.name;
    this.about = options.about ?? "";
    this.rules = options.rules ?? "";
    this.clock = options.clock;
    this.hearing = options.hearing ?? 35;
    this.sight = options.sight ?? 80;
    this.idleSeconds = options.idleSeconds ?? 45;
    this.farSlowdown = options.farSlowdown ?? 3;
    this.activeRadius = options.activeRadius ?? 120;
    this.farDelay = options.farDelay ?? 20;
    this.greetDistance = options.greetDistance ?? 12;
    this.turnsPerMinute = options.turnsPerMinute ?? 30;
    this.maxActions = options.maxActions ?? 3;
    this.chatReplies = options.chatReplies ?? 2;
    this.chatPause = options.chatPause ?? 90;
    this.needDefs = options.needs ?? {};
    this.memory = options.memory !== false;
    this.warn = options.warn ?? (() => undefined);
  }

  /** Listen for world events. Returns a function that unsubscribes. */
  on(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal */
  emit(event: WorldEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.warn(`world listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  addPlace(name: string, place: { description?: string; position: Position; radius?: number }): void {
    if (this.places.has(name)) throw new Error(`place already exists: ${name}`);
    this.places.set(name, { name, description: place.description ?? "", position: place.position, radius: place.radius ?? 22 });
  }

  addThing(id: string, thing: { name?: string; place?: string; position: Position; activities: Record<string, Activity> }): void {
    if (this.things.has(id)) throw new Error(`thing already exists: ${id}`);
    this.things.set(id, {
      id,
      name: thing.name ?? id.replaceAll("_", " "),
      ...(thing.place ? { place: thing.place } : {}),
      position: thing.position,
      activities: thing.activities,
      usedBy: null,
    });
  }

  /** Add a human player. getPosition returns null while they have no body. */
  addPerson(person: { name: string; getPosition: () => Position | null }): void {
    this.people.set(person.name, { name: person.name, getPosition: person.getPosition, carrying: [] });
  }

  removePerson(name: string): void {
    this.people.delete(name);
  }

  placeAt(position: Position): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const place of this.places.values()) {
      const d = distance(place.position, position);
      if (d <= place.radius && d < bestDistance) {
        best = place.name;
        bestDistance = d;
      }
    }
    return best;
  }

  positionOf(name: string): Position | null {
    return this.characters.get(name)?.position() ?? this.people.get(name)?.getPosition() ?? null;
  }

  /** Match a name the model wrote to someone in the world, ignoring case. */
  resolve(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const lower = name.trim().toLowerCase();
    for (const known of [...this.characters.keys(), ...this.people.keys()]) {
      if (known.toLowerCase() === lower) return known;
    }
    return undefined;
  }

  /** @internal */
  humanNear(position: Position, range: number): boolean {
    for (const person of this.people.values()) {
      const at = person.getPosition();
      if (at && distance(at, position) <= range) return true;
    }
    return false;
  }

  /** The instructions every character gets about this world. */
  guide(home?: string): string {
    const lines = [
      `You are a character who lives in ${this.name}. ${this.about}`,
      "You are not an assistant. You are a person with your own life, moods, and plans. Stay in character at all times.",
      "",
      "How you act:",
      "- You act only through tools. To speak, call say. Keep a line to one or two short sentences, the way people talk.",
      "- Each turn shows why you are acting now, who is near you, and what you can use where you are.",
      "- You can speak and then act in the same turn, for example say and then go_to. When you agree to do something, do it in that same turn: say yes, then go_to or use.",
      "- go_to, approach and use take time. You are told when they finish. Do not repeat them while they are under way.",
      "- use walks you to the thing by itself. To give something to someone who is not next to you, call approach and stop there; give it on your next turn, once you have arrived.",
      "- When someone speaks to you, answer them. When nothing needs doing, carry on with your day the way your story says, or call idle.",
      "- A chat between neighbours is a few lines, then you both get on with your day. Do not answer a goodbye or a line that needs no answer.",
      "- If someone does not answer you, leave them be and get on with your day. Do not keep talking to a person who stays silent.",
      "- Do not repeat yourself. Check your recent events before you speak.",
      "- People you do not know are strangers. Treat people the way you feel about them.",
      "",
      "Places:",
    ];
    for (const place of this.places.values()) {
      lines.push(`- ${place.name}${place.description ? `: ${place.description}` : ""}${home === place.name ? " (your home)" : ""}`);
    }
    if (Object.keys(this.needDefs).length > 0) {
      lines.push("", "Your needs run from 0 (desperate) to 100 (satisfied) and fall over time. Look after them with the things around you.");
    }
    if (this.rules) lines.push("", this.rules);
    return lines.join("\n");
  }

  /** Add a character and start its session. id is the character ID from the web app. */
  async addCharacter(def: {
    id: string;
    name: string;
    body: Body;
    home?: string;
    goal?: string;
    instructions?: string;
    carrying?: string[];
  }): Promise<Character> {
    if (this.characters.has(def.name)) throw new Error(`character already exists: ${def.name}`);
    const character = new Character(this, def.name, def.body, def.home, def.carrying ?? []);
    for (const [need, spec] of Object.entries(this.needDefs)) {
      character.needs[need] = spec.start ?? 55 + Math.floor(Math.random() * 36);
    }
    const instructions = [this.guide(def.home), def.instructions].filter(Boolean).join("\n\n");
    character.agent = await this.server.start(new CharacterTools(character), {
      name: def.name,
      playerId: def.id,
      instructions,
      ownInstructions: true,
      memory: this.memory,
      maxActions: this.maxActions,
      subgoals: false,
      ...(def.goal ? { goal: def.goal } : {}),
    });
    this.characters.set(def.name, character);
    character.agent.on((event) => {
      if (event.type === "relationship") {
        this.emit({
          type: "relationship",
          character: character.name,
          about: this.resolve(event.about) ?? event.about,
          affinity: event.affinity,
          label: event.label,
          change: event.change,
          because: event.because,
        });
      } else if (event.type === "memory") {
        this.emit({ type: "memory", character: character.name, about: event.about, note: event.note });
      } else if (event.type === "action") {
        this.emit({ type: "action", character: character.name, action: event.action, args: event.args });
      }
    });
    return character;
  }

  /** @internal Carry a spoken line to everyone who can hear it. Returns how many heard it. */
  speech(speaker: string, text: string, to: string | undefined): number {
    const from = this.positionOf(speaker);
    if (!from) return 0;
    const speakerIsCharacter = this.characters.has(speaker);
    let heard = 0;
    for (const person of this.people.values()) {
      const at = person.getPosition();
      if (person.name !== speaker && at && distance(at, from) <= this.hearing) heard += 1;
    }
    // A line with no addressee is taken by the closest resident in talking range.
    let closest: string | undefined;
    if (!to) {
      let closestDistance = 16;
      for (const other of this.characters.values()) {
        const d = distance(other.position(), from);
        if (other.name !== speaker && d < closestDistance) {
          closest = other.name;
          closestDistance = d;
        }
      }
    }
    for (const other of this.characters.values()) {
      if (other.name === speaker || distance(other.position(), from) > this.hearing) continue;
      heard += 1;
      const addressed = to === other.name || (!to && closest === other.name);
      const line = addressed
        ? `${speaker} said to you: "${text}"`
        : to
          ? `${speaker} said to ${to}: "${text}"`
          : `${speaker} said: "${text}"`;
      // Two residents talking stop after a few exchanges, so a chat cannot run forever.
      const turn = addressed && (!speakerIsCharacter || other.mayReplyToCharacter());
      if (addressed && !other.status) other.body.face?.(from);
      // A human gets an answer at once; a neighbour waits a breath.
      other.notice(line, { about: speaker, urgent: turn && !speakerIsCharacter, turn });
    }
    this.emit({ type: "speech", speaker, text, ...(to ? { to } : {}) });
    return heard;
  }

  /** A human player said something. Without to, the closest resident in talking range takes it. */
  say(speaker: string, text: string, to?: string): number {
    const line = clip(text.trim(), 300);
    if (!line || !this.people.has(speaker)) return 0;
    return this.speech(speaker, line, this.resolve(to));
  }

  /** Tell one character something happened, in plain words. */
  tell(characterName: string, text: string, options: NoticeOptions = { turn: true }): void {
    this.characters.get(characterName)?.notice(text, options);
  }

  /** Tell every character within range of a position that something happened. */
  announce(text: string, position?: Position, range?: number): void {
    for (const character of this.characters.values()) {
      if (!position || distance(character.position(), position) <= (range ?? this.sight)) {
        character.notice(text, { turn: true });
      }
    }
  }

  /** A human player hands an item to a character. */
  give(from: string, characterName: string, item: string): boolean {
    const character = this.characters.get(characterName);
    if (!character) return false;
    character.carrying.push(item);
    character.notice(`${from} gave you ${item}.`, { about: from, urgent: true });
    this.emit({ type: "give", from, to: characterName, item });
    return true;
  }

  private spend(): boolean {
    const at = now();
    this.budget = Math.min(this.turnsPerMinute, this.budget + ((at - this.budgetAt) * this.turnsPerMinute) / 60);
    this.budgetAt = at;
    if (this.budget < 1) return false;
    this.budget -= 1;
    return true;
  }

  private idleDelay(character: Character): number {
    const delay = this.idleSeconds * (0.75 + Math.random() * 0.5);
    return this.humanNear(character.position(), this.activeRadius) ? delay : delay * this.farSlowdown;
  }

  private runTurn(character: Character): void {
    character.wake = null;
    character.busy = true;
    this.emit({ type: "thinking", character: character.name, on: true });
    character.agent
      .turn()
      .then((result) => {
        character.tokens += result.usage.promptTokens + result.usage.completionTokens;
        this.emit({ type: "turn", character: character.name, ok: true, result });
        character.wakeIn(character.inbox.length > 0 ? 1 : this.idleDelay(character));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.warn(`${character.name} turn failed: ${message}`);
        this.emit({ type: "turn", character: character.name, ok: false, error: message });
        character.wakeIn(Math.max(20, this.idleSeconds));
      })
      .finally(() => {
        character.busy = false;
        character.turns += 1;
        this.turnsUsed += 1;
        this.emit({ type: "thinking", character: character.name, on: false });
      });
  }

  private tick(): void {
    const at = now();
    const dt = at - this.lastTick;
    this.lastTick = at;
    for (const character of this.characters.values()) {
      // Needs fall over time. A need that gets low is worth a turn.
      for (const [need, spec] of Object.entries(this.needDefs)) {
        const value = Math.max(0, (character.needs[need] ?? 0) - (spec.perMinute * dt) / 60);
        character.needs[need] = value;
        if (value < 25 && !character.needWarned.has(need)) {
          character.needWarned.add(need);
          character.notice(`Your ${need} is getting low (${Math.floor(value)}).`, { turn: true });
        } else if (value > 50) {
          character.needWarned.delete(need);
        }
      }
      // Notice a human who walks up.
      if (this.greetDistance > 0) {
        const here = character.position();
        for (const person of this.people.values()) {
          const where = person.getPosition();
          if (!where || distance(where, here) > this.greetDistance) continue;
          const last = character.greeted.get(person.name);
          character.greeted.set(person.name, at);
          if (last === undefined || at - last > 150) {
            character.notice(`${person.name} walked up to you.`, { about: person.name, turn: true });
          }
        }
      }
      // A character that is walking or busy gets no idle turns, only turns
      // for things that happened.
      if (character.wake !== null && at >= character.wake && !character.busy) {
        if (character.status && character.inbox.length === 0) {
          character.wake = at + 5;
        } else if (this.spend()) {
          this.runTurn(character);
        }
      }
    }
  }

  /** Start giving characters turns. Call it once, after adding the characters. */
  start(): void {
    if (this.timer) return;
    this.budget = Math.min(this.turnsPerMinute, 6);
    this.budgetAt = now();
    this.lastTick = now();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.warn(`world tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 500);
  }

  /** Stop giving turns. Sessions stay open until the server closes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
