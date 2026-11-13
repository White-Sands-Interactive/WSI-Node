/**
 * A walking body on the town map. Residents and visitors use the same one.
 * It is the only thing the World layer needs from the game engine.
 */
import type { Body, Position } from "@whitesands/agent-player";
import { findPath } from "./map.js";

export class WalkerBody implements Body {
  x: number;
  y: number;
  /** Direction faced, in radians. 0 is east, PI/2 is south. */
  facing = Math.PI / 2;
  moving = false;
  status: string | null = null;
  emotes = ["wave", "laugh", "cheer", "dance", "point", "shrug"];
  private path: Position[] = [];
  private arrived: ((reached: boolean) => void) | null = null;

  constructor(
    start: Position,
    readonly speed: number,
    private readonly hooks: { say?: (text: string) => void; emote?: (name: string) => void } = {},
  ) {
    this.x = start.x;
    this.y = start.y;
  }

  getPosition(): Position {
    return { x: this.x, y: this.y };
  }

  moveTo(goal: Position): Promise<boolean> {
    this.stop();
    const path = findPath(this.getPosition(), goal);
    if (!path) return Promise.resolve(false);
    if (path.length === 0) return Promise.resolve(true);
    this.path = path;
    this.moving = true;
    return new Promise((resolve) => {
      this.arrived = resolve;
    });
  }

  stop(): void {
    this.path = [];
    this.moving = false;
    const arrived = this.arrived;
    this.arrived = null;
    arrived?.(false);
  }

  say(text: string, towards?: Position): string {
    if (towards) this.face(towards);
    this.hooks.say?.(text);
    return text;
  }

  emote(name: string): void {
    this.hooks.emote?.(name);
  }

  face(position: Position): void {
    if (!this.moving && (position.x !== this.x || position.y !== this.y)) {
      this.facing = Math.atan2(position.y - this.y, position.x - this.x);
    }
  }

  setStatus(status: string | null): void {
    this.status = status;
  }

  /** Advance along the path. Called by the game loop. */
  tick(dt: number): void {
    let budget = this.speed * dt;
    while (budget > 0 && this.path.length > 0) {
      const next = this.path[0]!;
      const dx = next.x - this.x;
      const dy = next.y - this.y;
      const gap = Math.hypot(dx, dy);
      if (gap > 0.001) this.facing = Math.atan2(dy, dx);
      if (gap <= budget) {
        this.x = next.x;
        this.y = next.y;
        this.path.shift();
        budget -= gap;
      } else {
        this.x += (dx / gap) * budget;
        this.y += (dy / gap) * budget;
        budget = 0;
      }
    }
    if (this.moving && this.path.length === 0) {
      this.moving = false;
      const arrived = this.arrived;
      this.arrived = null;
      arrived?.(true);
    }
  }
}
