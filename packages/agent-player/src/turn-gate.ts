/**
 * Coordinates game-side turn() with the agent's wait tool.
 * turn() releases wait, then resolves when the platform reports the turn finished.
 */
export class TurnGate {
  private waitResolve: (() => void) | null = null;
  private waitPromise: Promise<void> | null = null;
  private turnResolve: ((result: TurnOutcome) => void) | null = null;
  private turnPromise: Promise<TurnOutcome> | null = null;
  private released = false;

  /** Called by the wait tool: blocks until turn() releases this session. */
  async waitForTurn(): Promise<void> {
    if (this.released) {
      this.released = false;
      return;
    }
    if (!this.waitPromise) {
      this.waitPromise = new Promise<void>((resolve) => {
        this.waitResolve = resolve;
      });
    }
    await this.waitPromise;
    this.waitPromise = null;
    this.waitResolve = null;
    this.released = false;
  }

  /**
   * Called by AgentHandle.turn(): unblock wait and wait for platform turn_result.
   */
  async runTurn(): Promise<TurnOutcome> {
    if (this.turnPromise) {
      throw new Error("turn() already in progress for this session");
    }
    this.turnPromise = new Promise<TurnOutcome>((resolve) => {
      this.turnResolve = resolve;
    });
    this.released = true;
    const wr = this.waitResolve;
    this.waitResolve = null;
    this.waitPromise = null;
    wr?.();
    const outcome = await this.turnPromise;
    this.turnPromise = null;
    this.turnResolve = null;
    return outcome;
  }

  /** Platform finished one action cycle (ok or second failure). */
  completeTurn(outcome: TurnOutcome): void {
    const resolve = this.turnResolve;
    if (!resolve) return;
    this.turnResolve = null;
    this.turnPromise = null;
    resolve(outcome);
  }

  reset(): void {
    this.waitResolve?.();
    this.turnResolve?.({ ok: false, error: "session stopped" });
    this.waitResolve = null;
    this.waitPromise = null;
    this.turnResolve = null;
    this.turnPromise = null;
    this.released = false;
  }
}

export type TurnOutcome = { ok: true } | { ok: false; error: string };
