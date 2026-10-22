import { z } from "zod";

const DOOR = 3;

export class Courier {
  static agent = {
    description: "A courier carrying one parcel along a street",
    actions: {
      walk: {
        description: "Move dx steps. Positive is toward the door.",
        args: { dx: z.number().int() },
      },
      deliver: {
        description: `Hand over the parcel. Only works at x = ${DOOR}.`,
      },
    },
  };

  delivered = false;

  constructor(public x = 0) {}

  see() {
    return {
      x: this.x,
      door: DOOR,
      carrying: !this.delivered,
    };
  }

  walk(dx: number) {
    const next = this.x + dx;
    if (next < 0 || next > DOOR) {
      throw new Error(`Cannot walk to ${next}; the street is 0..${DOOR}`);
    }
    this.x = next;
    return { x: this.x };
  }

  deliver() {
    if (this.x !== DOOR) throw new Error(`The door is at ${DOOR}, you are at ${this.x}`);
    if (this.delivered) throw new Error("Already delivered");
    this.delivered = true;
    return { delivered: true };
  }
}
