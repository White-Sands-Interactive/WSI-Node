/**
 * Sandy Shores, web edition: a small town where every resident is a White
 * Sands character. This file is the game server: it serves the browser
 * client, runs the game loop, and lets visitors walk, talk, give and invite.
 *
 * The residents are not scripted here. Each one is a session on the White
 * Sands platform, which plays it through the MCP tools the SDK's World layer
 * serves (say, go_to, approach, use, give, emote). Their roles and stories
 * are plain English on the platform.
 *
 *   WSI_PLATFORM_KEY=pk_... WSI_PLATFORM_URL=wss://... npm start
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentServer, World } from "@whitesands/agent-player";
import { WebSocketServer, type WebSocket } from "ws";
import { WalkerBody } from "./body.js";
import { cast } from "./cast.js";
import { BOUNDS, places, props, spawn, things } from "./map.js";

const PORT = Number(process.env.PORT ?? 8080);
const SECONDS_PER_GAME_HOUR = 45;
const START_HOUR = 8;
const MAX_VISITORS = 12;
const MAX_ITEMS = 6;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const GESTURES: Record<string, string> = {
  wave: "%s waves at you.",
  hug: "%s gives you a hug.",
  high_five: "%s offers you a high five.",
  compliment: "%s pays you a sincere compliment.",
};
const INVITES: Record<string, string> = {
  coffee: "have a coffee together at the cafe",
  dance: "dance together at the plaza boombox",
  fishing: "go fishing together at the pier",
  bonfire: "sit by the campfire together on the beach",
  picnic: "have a picnic together in the park",
};

// Clock ----------------------------------------------------------------------
const startedAt = Date.now();
const gameHours = () => START_HOUR + (Date.now() - startedAt) / 1000 / SECONDS_PER_GAME_HOUR;
function clockText(): string {
  const hours = gameHours();
  const hour = Math.floor(hours % 24);
  const minute = Math.floor((hours % 1) * 60);
  const part = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 14 ? "midday" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night";
  return `Day ${Math.floor(hours / 24) + 1}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${part})`;
}

// Visitors -------------------------------------------------------------------
type Visitor = { name: string; socket: WebSocket; body: WalkerBody; items: string[]; lastAction: number; look: number };
const visitors = new Map<WebSocket, Visitor>();
const bodies = new Map<string, WalkerBody>();
const looks = new Map<string, unknown>();
const thinking = new Set<string>();

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
function broadcast(message: Record<string, unknown>): void {
  const raw = JSON.stringify(message);
  for (const socket of visitors.keys()) if (socket.readyState === socket.OPEN) socket.send(raw);
}

// World ----------------------------------------------------------------------
const server = new AgentServer({
  ...(process.env.WSI_PLATFORM_URL ? { platformUrl: process.env.WSI_PLATFORM_URL } : {}),
  memoryPath: false,
  turnTimeoutMs: 75_000,
  logger: {
    warn: (message: string) => console.warn("[wsi]", message),
    error: (message: string) => console.error("[wsi]", message),
  },
});
const world = new World(server, {
  name: "Sandy Shores",
  about: "It is a small, friendly beach town where everybody knows everybody. Visitors (players) come and go, and some become friends.",
  rules:
    "A visitor can give you things, wave, hug, high five, compliment you, or invite you to do something together. React the way you feel about them: a hug from a stranger is odd, a hug from a friend is lovely. When you accept an invitation, say so and go_to the place. When you would rather not, say so kindly.",
  clock: clockText,
  needs: { food: { perMinute: 1.2 }, energy: { perMinute: 0.9 }, fun: { perMinute: 1.4 } },
  idleSeconds: 60,
  turnsPerMinute: 20,
  warn: (message) => console.warn("[world]", message),
});
for (const place of places) world.addPlace(place.name, place);
for (const thing of things) world.addThing(thing.id, { place: thing.place, position: thing.position, activities: thing.activities });

function sendPeople(visitor: Visitor): void {
  const rows = [...world.characters.values()].map((character) => ({ name: character.name, ...character.feelingFor(visitor.name), status: character.status }));
  send(visitor.socket, { t: "people", rows });
}

world.on((event) => {
  if (event.type === "speech") {
    broadcast({ t: "speech", speaker: event.speaker, text: event.text, to: event.to ?? null });
  } else if (event.type === "relationship") {
    for (const visitor of visitors.values()) {
      if (visitor.name.toLowerCase() === event.about.toLowerCase()) {
        send(visitor.socket, { t: "rel", name: event.character, affinity: event.affinity, label: event.label, change: event.change, because: event.because });
      }
    }
  } else if (event.type === "thinking") {
    if (event.on) thinking.add(event.character);
    else thinking.delete(event.character);
  } else if (event.type === "emote") {
    broadcast({ t: "emote", name: event.character, emote: event.emote });
  } else if (event.type === "give") {
    for (const visitor of visitors.values()) {
      if (visitor.name !== event.to) continue;
      world.people.get(visitor.name)?.carrying.splice(0);
      if (visitor.items.length < MAX_ITEMS) visitor.items.push(event.item);
      send(visitor.socket, { t: "items", items: visitor.items });
      send(visitor.socket, { t: "toast", text: `${event.from} gave you: ${event.item}`, good: true });
    }
  } else if (event.type === "turn") {
    const usage = event.result?.usage;
    console.log(`[turn] ${event.character} ${event.ok ? (event.result?.steps ?? [{ action: event.result?.action }]).map((step) => step.action).join("+") : `failed: ${event.error}`}${usage ? ` (${usage.promptTokens + usage.completionTokens} tokens)` : ""}`);
  }
});

// HTTP: the browser client -----------------------------------------------------
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const http = createServer((request, response) => {
  const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
  if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, residents: world.characters.size, visitors: visitors.size, turns: world.turnsUsed }));
    return;
  }
  const file = join(PUBLIC_DIR, path === "/" ? "index.html" : path);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(response);
});

// WebSocket: visitors -----------------------------------------------------------
const sockets = new WebSocketServer({ server: http });

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 16) || "Visitor";
  let unique = name;
  for (let n = 2; world.characters.has(unique) || world.people.has(unique); n++) unique = `${name} ${n}`;
  return unique;
}

function near(visitor: Visitor, name: string, range: number): boolean {
  const at = world.positionOf(name);
  return at !== null && Math.hypot(at.x - visitor.body.x, at.y - visitor.body.y) <= range;
}

sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    let visitor = visitors.get(socket);
    if (message.t === "join" && !visitor) {
      if (visitors.size >= MAX_VISITORS) {
        send(socket, { t: "full" });
        return;
      }
      const name = cleanName(message.name);
      const body = new WalkerBody({ x: spawn.x + (Math.random() - 0.5) * 8, y: spawn.y + Math.random() * 4 }, 22);
      visitor = { name, socket, body, items: [], lastAction: 0, look: Math.floor(Math.random() * 6) };
      visitors.set(socket, visitor);
      bodies.set(name, body);
      looks.set(name, visitor.look);
      world.addPerson({ name, getPosition: () => body.getPosition() });
      send(socket, {
        t: "init",
        you: name,
        bounds: BOUNDS,
        props,
        places: places.map((place) => ({ name: place.name, x: place.position.x, y: place.position.y })),
        things: things.map((thing) => ({ id: thing.id, x: thing.position.x, y: thing.position.y, verb: thing.visitor?.verb ?? null })),
        looks: Object.fromEntries(cast.map((member) => [member.name, member.look])),
        gestures: Object.keys(GESTURES),
        invites: Object.keys(INVITES),
      });
      sendPeople(visitor);
      console.log(`[visitor] ${name} joined (${visitors.size} online)`);
      return;
    }
    if (!visitor) return;
    if (message.t === "move") {
      const x = Number(message.x);
      const y = Number(message.y);
      if (Number.isFinite(x) && Number.isFinite(y)) void visitor.body.moveTo({ x, y });
      return;
    }
    const at = Date.now();
    if (at - visitor.lastAction < 700) return;
    visitor.lastAction = at;
    const to = typeof message.to === "string" ? world.resolve(message.to) : undefined;
    const target = to ? world.characters.get(to) : undefined;
    if (message.t === "use") {
      const thing = things.find((candidate) => candidate.id === message.thing);
      if (!thing?.visitor || Math.hypot(thing.position.x - visitor.body.x, thing.position.y - visitor.body.y) > 10) return;
      if (visitor.items.length >= MAX_ITEMS) {
        send(socket, { t: "toast", text: "Your hands are full." });
        return;
      }
      visitor.items.push(thing.visitor.gives);
      send(socket, { t: "items", items: visitor.items });
      send(socket, { t: "toast", text: `You got: ${thing.visitor.gives}`, good: true });
      world.announce(`${visitor.name} used the ${thing.id.replaceAll("_", " ")} and now has a ${thing.visitor.gives}.`, thing.position, 30);
      return;
    }
    if (message.t === "say" && typeof message.text === "string") {
      const text = message.text.slice(0, 200);
      // Speech reaches whoever is in earshot; a named resident who is too far simply does not hear it.
      world.say(visitor.name, text, target && near(visitor, target.name, world.hearing) ? target.name : undefined);
      return;
    }
    if (!target || !near(visitor, target.name, 24)) {
      send(socket, { t: "toast", text: "Get closer first." });
      return;
    }
    if (message.t === "gesture" && typeof message.gesture === "string" && GESTURES[message.gesture]) {
      target.notice(GESTURES[message.gesture]!.replace("%s", visitor.name), { about: visitor.name, urgent: true });
      broadcast({ t: "emote", name: visitor.name, emote: message.gesture });
    } else if (message.t === "invite" && typeof message.invite === "string" && INVITES[message.invite]) {
      target.notice(`${visitor.name} invites you to ${INVITES[message.invite]}, right now.`, { about: visitor.name, urgent: true });
    } else if (message.t === "give" && typeof message.item === "string") {
      const index = visitor.items.indexOf(message.item);
      if (index < 0) return;
      visitor.items.splice(index, 1);
      send(socket, { t: "items", items: visitor.items });
      world.give(visitor.name, target.name, message.item);
    }
  });
  socket.on("close", () => {
    const visitor = visitors.get(socket);
    if (!visitor) return;
    visitors.delete(socket);
    bodies.delete(visitor.name);
    looks.delete(visitor.name);
    world.removePerson(visitor.name);
    console.log(`[visitor] ${visitor.name} left (${visitors.size} online)`);
  });
});

// Game loop ---------------------------------------------------------------------
let last = Date.now();
let frame = 0;
setInterval(() => {
  const at = Date.now();
  const dt = Math.min(0.2, (at - last) / 1000);
  last = at;
  for (const body of bodies.values()) body.tick(dt);
  frame += 1;
  if (frame % 2 !== 0 || visitors.size === 0) return;
  const entities = [...bodies.entries()].map(([name, body]) => ({
    n: name,
    k: world.characters.has(name) ? 1 : 0,
    x: Math.round(body.x * 10) / 10,
    y: Math.round(body.y * 10) / 10,
    f: Math.round(body.facing * 100) / 100,
    m: body.moving ? 1 : 0,
    s: world.characters.get(name)?.status ?? null,
    t: thinking.has(name) ? 1 : 0,
    l: looks.get(name),
  }));
  broadcast({ t: "state", hour: gameHours() % 24, entities });
}, 50);

setInterval(() => {
  for (const visitor of visitors.values()) sendPeople(visitor);
}, 5000);

// Boot ----------------------------------------------------------------------------
http.listen(PORT, () => console.log(`[town] listening on :${PORT}`));

const placeAt = new Map(places.map((place) => [place.name, place.position]));
for (const [index, member] of cast.entries()) {
  const start = placeAt.get(member.startsAt)!;
  const body = new WalkerBody({ x: start.x + ((index % 3) - 1) * 4, y: start.y + 3 }, 14, {
    emote: (name) => broadcast({ t: "emote", name: member.name, emote: name }),
  });
  bodies.set(member.name, body);
  looks.set(member.name, member.look);
  try {
    await world.addCharacter({ id: member.id, name: member.name, body, home: member.home });
    console.log(`[town] ${member.name} is in town`);
  } catch (error) {
    bodies.delete(member.name);
    console.error(`[town] ${member.name} could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
world.start();
console.log(`[town] the town is awake: ${world.characters.size} residents`);

setInterval(() => {
  const parts = [...world.characters.values()].map((character) => `${character.name} ${character.turns} turns/${Math.floor(character.tokens / 1000)}k`);
  console.log(`[town] usage: ${parts.join(", ")}`);
}, 120_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    world.stop();
    void server.close().finally(() => process.exit(0));
  });
}
