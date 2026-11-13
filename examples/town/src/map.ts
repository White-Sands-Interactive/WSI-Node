/**
 * The town map: what is where, what blocks walking, and how to get from A to
 * B. This is game engine code. It knows nothing about who lives here.
 *
 * Units are metres. +x is east, +y is south (towards the sea).
 */
import type { Activity, Position } from "@whitesands/agent-player";

export const BOUNDS = { minX: -160, maxX: 160, minY: -150, maxY: 250 };
const CELL = 2;
const COLS = (BOUNDS.maxX - BOUNDS.minX) / CELL;
const ROWS = (BOUNDS.maxY - BOUNDS.minY) / CELL;

export type Prop = {
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  color?: string;
  roof?: string;
  label?: string;
};

export type PlaceDef = { name: string; description: string; position: Position; radius: number };
export type ThingDef = {
  id: string;
  place: string;
  position: Position;
  activities: Record<string, Activity>;
  /** What a human visitor gets from it. */
  visitor?: { verb: string; gives: string };
};

export const places: PlaceDef[] = [];
export const things: ThingDef[] = [];
export const props: Prop[] = [];
const blocked = new Uint8Array(COLS * ROWS);

const cellOf = (x: number, y: number) => ({
  c: Math.min(COLS - 1, Math.max(0, Math.floor((x - BOUNDS.minX) / CELL))),
  r: Math.min(ROWS - 1, Math.max(0, Math.floor((y - BOUNDS.minY) / CELL))),
});
const centre = (c: number, r: number): Position => ({ x: BOUNDS.minX + (c + 0.5) * CELL, y: BOUNDS.minY + (r + 0.5) * CELL });

function blockRect(x: number, y: number, w: number, h: number, value = 1): void {
  const a = cellOf(x - w / 2, y - h / 2);
  const b = cellOf(x + w / 2 - 0.01, y + h / 2 - 0.01);
  for (let r = a.r; r <= b.r; r++) for (let c = a.c; c <= b.c; c++) blocked[r * COLS + c] = value;
}

function place(name: string, description: string, x: number, y: number, radius: number): void {
  places.push({ name, description, position: { x, y }, radius });
}

function thing(id: string, placeName: string, x: number, y: number, activities: Record<string, Activity>, visitor?: ThingDef["visitor"]): void {
  things.push({ id, place: placeName, position: { x, y }, activities, ...(visitor ? { visitor } : {}) });
}

// An open-fronted building: back and side walls block, the south side is open.
function building(type: string, label: string, x: number, y: number, w: number, h: number, color: string, roof: string): void {
  props.push({ type, x, y, w, h, color, roof, label });
  blockRect(x, y - h / 2 + 1, w, 2);
  blockRect(x - w / 2 + 1, y, 2, h);
  blockRect(x + w / 2 - 1, y, 2, h);
}

function solid(type: string, x: number, y: number, w: number, h: number, extra: Partial<Prop> = {}): void {
  props.push({ type, x, y, w, h, ...extra });
  blockRect(x, y, w, h);
}

// How long activities take, relative to their written length. Each finished
// activity is a turn, so this is the main pacing knob.
const PACE = 3;
const paced = (activity: Activity): Activity => ({ ...activity, seconds: (activity.seconds ?? 5) * PACE });

function build(): void {
  // The sea blocks walking, except along the pier.
  blockRect(0, 221, 320, 58);
  blockRect(110, 200, 10, 70, 0);
  props.push({ type: "pier", x: 110, y: 200, w: 10, h: 70 });

  place("plaza", "The town square, with a fountain and a boombox. The cafe and the general store face it.", 0, 8, 30);
  solid("fountain", 0, 0, 14, 14, { r: 7 });
  thing("fountain", "plaza", 0, 10, {
    sit_by_the_fountain: paced({ description: "Sit by the fountain and watch the plaza", seconds: 8, status: "sitting by the fountain", effects: { fun: 15, energy: 5 } }),
  });
  solid("boombox", -18, 14, 4, 2);
  thing("boombox", "plaza", -14, 18, {
    dance: paced({ description: "Dance to the music", seconds: 8, status: "dancing", emote: "dance", effects: { fun: 35, energy: -5 } }),
  });
  solid("bench", -22, -14, 8, 2.4);
  solid("bench", 22, -14, 8, 2.4);

  place("cafe", "The Driftwood Cafe, Mia's place: coffee, pastries, and a few tables.", 66, 4, 26);
  building("building", "Driftwood Cafe", 74, -6, 34, 24, "#fae2be", "#cc5c48");
  solid("counter", 74, -10, 16, 2.4);
  props.push({ type: "espresso", x: 79, y: -10 });
  thing("espresso_machine", "cafe", 79, -5.5, {
    make_coffee: paced({ description: "Make a fresh coffee to drink or to give to someone", seconds: 6, status: "making coffee", gives: "coffee" }),
  }, { verb: "Get a coffee", gives: "coffee" });
  solid("table", 62, 12, 5, 5, { r: 2.5 });
  thing("cafe_table", "cafe", 62, 16.5, {
    eat_a_meal: paced({ description: "Sit down and eat a proper meal", seconds: 8, status: "eating at the cafe", effects: { food: 55 } }),
    drink_coffee: paced({ description: "Drink the coffee you are carrying", seconds: 5, status: "drinking coffee", needs: "coffee", effects: { energy: 25, fun: 5 } }),
  });

  place("general_store", "Ruby's general store, with a flower stand outside.", -66, 4, 26);
  building("building", "General Store", -74, -6, 34, 24, "#c4dee8", "#486ea0");
  solid("shelves", -74, -15, 20, 2);
  thing("store_shelves", "general_store", -74, -10, {
    restock_shelves: paced({ description: "Restock and tidy the shelves", seconds: 8, status: "restocking shelves", effects: { fun: 5 } }),
  });
  solid("flowerstand", -58, 12, 7, 3);
  thing("flower_stand", "general_store", -58, 16.5, {
    arrange_flowers: paced({ description: "Arrange a bouquet to give to someone", seconds: 6, status: "arranging flowers", gives: "bouquet", effects: { fun: 10 } }),
  }, { verb: "Buy a bouquet", gives: "bouquet" });

  place("park", "A quiet park with trees, a flower garden, a picnic table, and Leo's easel.", -110, -40, 34);
  for (const [x, y] of [[-128, -60], [-96, -64], [-132, -24], [-88, -20], [-140, -44], [-150, -70], [-76, -52]] as const) {
    props.push({ type: "tree", x, y, r: 5 });
    blockRect(x, y, 2, 2);
  }
  solid("easel", -112, -52, 4, 2);
  thing("easel", "park", -112, -47, {
    paint: paced({ description: "Paint a picture", seconds: 10, status: "painting", gives: "painting", effects: { fun: 30 } }),
  });
  props.push({ type: "garden", x: -120, y: -30, w: 14, h: 8 });
  thing("flower_garden", "park", -120, -24, {
    pick_a_flower: paced({ description: "Pick a flower to give to someone", seconds: 4, status: "picking flowers", gives: "flower" }),
  }, { verb: "Pick a flower", gives: "flower" });
  solid("picnic", -100, -36, 8, 4);
  thing("picnic_table", "park", -100, -31, {
    have_a_picnic: paced({ description: "Have a quiet picnic", seconds: 8, status: "having a picnic", effects: { food: 40, fun: 10 } }),
  });

  place("beach", "The beach: sand, surf, a campfire ring, and the fishing pier.", 0, 120, 60);
  for (const [x, y] of [[-70, 96], [64, 100], [-120, 120], [130, 112], [-10, 88], [150, 150]] as const) {
    props.push({ type: "palm", x, y, r: 5 });
    blockRect(x, y, 2, 2);
  }
  solid("campfire", -34, 128, 4, 4, { r: 2.5 });
  thing("campfire", "beach", -34, 121, {
    cook_fish: paced({ description: "Cook the fish you are carrying and eat it", seconds: 8, status: "cooking fish", needs: "fish", effects: { food: 50 } }),
    sit_by_the_fire: paced({ description: "Sit by the fire and relax", seconds: 8, status: "sitting by the fire", effects: { fun: 20, energy: 10 } }),
  });
  solid("surfboards", 40, 150, 6, 2);
  thing("surfboards", "beach", 40, 144, {
    surf: paced({ description: "Grab a board and surf", seconds: 10, status: "surfing", effects: { fun: 45, energy: -10 } }),
  });
  for (const [x, y] of [[-90, 140], [90, 132], [10, 160]] as const) props.push({ type: "towel", x, y, w: 4, h: 7 });

  place("pier", "The fishing pier at the east end of the beach. Finn's spot.", 110, 176, 26);
  props.push({ type: "fishingspot", x: 110, y: 230 });
  thing("fishing_spot", "pier", 110, 224, {
    fish: paced({ description: "Cast a line and catch a fish", seconds: 10, status: "fishing", gives: "fish", effects: { fun: 20 } }),
  }, { verb: "Go fishing", gives: "fish" });

  const cottages = [
    ["Mia", -100, "#ffd6aa"],
    ["Finn", -50, "#b0c4d2"],
    ["Ruby", 0, "#f4bec8"],
    ["Leo", 50, "#c8e0be"],
    ["Juno", 100, "#d6bef0"],
  ] as const;
  for (const [owner, x, color] of cottages) {
    const name = `${owner.toLowerCase()}_cottage`;
    place(name, `${owner}'s cottage.`, x, -112, 16);
    building("cottage", `${owner}'s cottage`, x, -122, 22, 18, color, "#8c5a50");
    solid("bed", x - 6, -125, 5, 9);
    thing(`${owner.toLowerCase()}_bed`, name, x - 1.5, -122, {
      sleep: paced({ description: "Sleep and get your energy back", seconds: 14, status: "sleeping", effects: { energy: 70 } }),
    });
    solid("fridge", x + 7, -128, 3, 3);
    thing(`${owner.toLowerCase()}_fridge`, name, x + 6, -123, {
      have_a_snack: paced({ description: "Grab a snack from the fridge", seconds: 5, status: "having a snack", effects: { food: 30 } }),
    });
  }
}
build();

export const spawn: Position = { x: 0, y: 26 };

export function walkable(x: number, y: number): boolean {
  if (x < BOUNDS.minX || x >= BOUNDS.maxX || y < BOUNDS.minY || y >= BOUNDS.maxY) return false;
  const { c, r } = cellOf(x, y);
  return blocked[r * COLS + c] === 0;
}

// The free cell nearest to a cell, found by widening rings.
function nearestFree(c: number, r: number): { c: number; r: number } | null {
  if (!blocked[r * COLS + c]) return { c, r };
  for (let radius = 1; radius < 12; radius++) {
    let best: { c: number; r: number } | null = null;
    let bestDistance = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS || blocked[rr * COLS + cc]) continue;
        const d = dc * dc + dr * dr;
        if (d < bestDistance) {
          best = { c: cc, r: rr };
          bestDistance = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

const NEIGHBOURS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;

/** A* over the walk grid. Returns waypoints ending at (or next to) the goal, or null. */
export function findPath(from: Position, to: Position): Position[] | null {
  const startCell = cellOf(from.x, from.y);
  const start = nearestFree(startCell.c, startCell.r);
  const goalCell = cellOf(to.x, to.y);
  const goal = nearestFree(goalCell.c, goalCell.r);
  if (!start || !goal) return null;
  const startIndex = start.r * COLS + start.c;
  const goalIndex = goal.r * COLS + goal.c;
  // Float64 so a stored cost equals the cost that was computed. With a rounded
  // cost, equal routes look like improvements and cells are reopened without end.
  const cost = new Float64Array(COLS * ROWS).fill(Infinity);
  const done = new Uint8Array(COLS * ROWS);
  const parent = new Int32Array(COLS * ROWS).fill(-1);
  const open: { index: number; score: number }[] = [{ index: startIndex, score: 0 }];
  cost[startIndex] = 0;
  const estimate = (index: number) => Math.hypot((index % COLS) - goal.c, Math.floor(index / COLS) - goal.r);
  while (open.length > 0) {
    let bestAt = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.score < open[bestAt]!.score) bestAt = i;
    const current = open.splice(bestAt, 1)[0]!.index;
    if (current === goalIndex) break;
    if (done[current]) continue;
    done[current] = 1;
    const c = current % COLS;
    const r = Math.floor(current / COLS);
    for (const [dc, dr, step] of NEIGHBOURS) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS) continue;
      const next = rr * COLS + cc;
      if (blocked[next] || done[next]) continue;
      // No cutting corners between two blocked cells.
      if (dc !== 0 && dr !== 0 && (blocked[r * COLS + cc] || blocked[rr * COLS + c])) continue;
      const total = cost[current]! + step;
      if (total < cost[next]!) {
        cost[next] = total;
        parent[next] = current;
        open.push({ index: next, score: total + estimate(next) });
      }
    }
  }
  if (parent[goalIndex] === -1 && goalIndex !== startIndex) return null;
  const cells: number[] = [];
  for (let at = goalIndex; at !== -1; at = parent[at]!) cells.push(at);
  cells.reverse();
  // Keep only the cells where the direction changes.
  const points: Position[] = [];
  for (let i = 1; i < cells.length; i++) {
    const previous = cells[i - 1]!;
    const current = cells[i]!;
    const next = cells[i + 1];
    if (next === undefined || next - current !== current - previous) {
      points.push(centre(current % COLS, Math.floor(current / COLS)));
    }
  }
  const goalFree = goal.c === goalCell.c && goal.r === goalCell.r;
  if (goalFree && walkable(to.x, to.y)) {
    if (points.length > 0) points[points.length - 1] = { x: to.x, y: to.y };
    else points.push({ x: to.x, y: to.y });
  }
  return points;
}
