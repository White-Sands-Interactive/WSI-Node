import type { Forest } from "./forest.js";

export class Villager {
  readonly name: string;
  private readonly world: Forest;
  x: number;
  y: number;
  wood = 0;

  constructor(world: Forest, name: string, x = 0, y = 0) {
    this.world = world;
    this.name = name;
    this.x = x;
    this.y = y;
  }

  /** State tool — current view for the agent. */
  see() {
    return {
      name: this.name,
      x: this.x,
      y: this.y,
      wood: this.wood,
      tile: this.world.get(this.x, this.y),
      treesLeft: this.world.treesLeft(),
      bounds: {
        minX: 0,
        minY: 0,
        maxX: this.world.width - 1,
        maxY: this.world.height - 1,
      },
      // Valid destinations stay inside [0..width) × [0..height).
      hint: "move(dx,dy) changes position by integer steps; stay in bounds. chop() only works on tile T.",
      map: this.world.render(),
    };
  }

  /** Move by dx, dy. Throws if the destination is out of bounds. */
  move(dx: number, dy: number) {
    const nx = this.x + dx;
    const ny = this.y + dy;
    if (!this.world.inBounds(nx, ny)) {
      throw new Error(`Cannot move to ${nx},${ny}`);
    }
    this.x = nx;
    this.y = ny;
    return { x: this.x, y: this.y, tile: this.world.get(this.x, this.y) };
  }

  /** Chop a tree on the current tile. Throws if there is no tree. */
  chop() {
    if (this.world.get(this.x, this.y) !== "T") {
      throw new Error(`No tree at ${this.x},${this.y}`);
    }
    this.world.set(this.x, this.y, ".");
    this.wood += 1;
    return { wood: this.wood, treesLeft: this.world.treesLeft() };
  }

  /** Hidden helper — must not become a tool. */
  _secret() {
    return "nope";
  }
}
