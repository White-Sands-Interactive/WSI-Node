import { z } from "zod";

const PASSENGERS = ["wolf", "goat", "cabbage"] as const;
type Passenger = (typeof PASSENGERS)[number];
type Cargo = Passenger | "none";
type Bank = "near" | "far";

/**
 * River crossing. The boat holds the ferryman and one passenger.
 * Left unsupervised, the wolf eats the goat and the goat eats the cabbage.
 * The wolf and the cabbage can wait together.
 */
export class Ferryman {
  static agent = {
    description: "A ferryman moving a wolf, a goat, and a cabbage across a river",
    actions: {
      cross: {
        description:
          "Cross to the other bank. passenger is someone on your current bank, or none to cross alone. Refuses a trip that would leave the wolf alone with the goat, or the goat alone with the cabbage.",
        args: { passenger: z.enum(["wolf", "goat", "cabbage", "none"]) },
      },
    },
  };

  boat: Bank = "near";
  private readonly near: Passenger[] = ["wolf", "goat", "cabbage"];
  private readonly far: Passenger[] = [];

  see() {
    return {
      boat: this.boat,
      near: listed(this.near),
      far: listed(this.far),
      solved: this.boat === "far" && this.far.length === PASSENGERS.length,
      rule: "The boat carries you and one passenger. Without you there, the wolf eats the goat and the goat eats the cabbage. The wolf and the cabbage may be left together.",
    };
  }

  cross(passenger: Cargo) {
    const from = this.boat === "near" ? this.near : this.far;
    const to = this.boat === "near" ? this.far : this.near;
    if (passenger !== "none" && !from.includes(passenger)) {
      const other = this.boat === "near" ? "far" : "near";
      throw new Error(`${passenger} is on the ${other} bank. You are on the ${this.boat} bank.`);
    }

    const leftBehind = from.filter((item) => item !== passenger);
    const danger = unsupervisedDanger(leftBehind);
    if (danger) throw new Error(danger);

    if (passenger !== "none") {
      from.splice(from.indexOf(passenger), 1);
      to.push(passenger);
    }
    this.boat = this.boat === "near" ? "far" : "near";
    return { boat: this.boat, near: listed(this.near), far: listed(this.far) };
  }
}

/** Display helper. Not a method, so the SDK does not offer it as a tool. */
export function render(ferry: Ferryman): string {
  const view = ferry.see();
  const boat = view.boat === "near" ? "boat ~ ~ ~ ~" : "~ ~ ~ ~ boat";
  return `near [${view.near.join(" ")}]  ${boat}  far [${view.far.join(" ")}]`;
}

function listed(items: readonly Passenger[]): Passenger[] {
  return PASSENGERS.filter((passenger) => items.includes(passenger));
}

function unsupervisedDanger(leftBehind: readonly Passenger[]): string | null {
  const wolf = leftBehind.includes("wolf");
  const goat = leftBehind.includes("goat");
  const cabbage = leftBehind.includes("cabbage");
  if (wolf && goat) return "The wolf would eat the goat on the bank you are leaving";
  if (goat && cabbage) return "The goat would eat the cabbage on the bank you are leaving";
  return null;
}
