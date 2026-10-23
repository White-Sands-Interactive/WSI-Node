import { TurnTimeoutError } from "./errors.js";
import type { TurnReport } from "./protocol.js";

export type TurnOutcome = TurnReport;

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("turn aborted");
}

/**
 * Coordinates game-side turn() with the agent's wait tool.
 * turn() releases wait, then resolves when the platform reports the turn finished.
 */
export class TurnGate {
  private waitResolve: (() => void) | null = null;
  private waitPromise: Promise<void> | null = null;
  private turnResolve: ((result: TurnOutcome) => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnPromise: Promise<TurnOutcome> | null = null;
  private released = false;

  /** Called by the wait tool. Blocks until turn() releases this session. */
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
   * Unblock wait and wait for the platform's turn report.
   * Rejects on timeout or abort; those do not produce a TurnOutcome.
   */
  async runTurn(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TurnOutcome> {
    if (this.turnPromise) {
      throw new Error("turn() already in progress for this session");
    }
    if (options?.signal?.aborted) {
      throw abortError(options.signal);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const signal = options?.signal;

    this.turnPromise = new Promise<TurnOutcome>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
      if (options?.timeoutMs != null) {
        timeoutId = setTimeout(() => {
          this.rejectTurn(new TurnTimeoutError(`turn() timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }
      if (signal) {
        if (signal.aborted) {
          this.rejectTurn(abortError(signal));
          return;
        }
        onAbort = () => this.rejectTurn(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    this.released = true;
    const release = this.waitResolve;
    this.waitResolve = null;
    this.waitPromise = null;
    release?.();

    try {
      return await this.turnPromise;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      this.turnPromise = null;
      this.turnResolve = null;
      this.turnReject = null;
    }
  }

  /** Platform finished one action cycle (success or second failure). */
  completeTurn(outcome: TurnOutcome): void {
    const resolve = this.turnResolve;
    if (!resolve) return;
    this.turnResolve = null;
    this.turnReject = null;
    resolve(outcome);
  }

  /** Fail an in-flight turn, for example when the connection cannot be resumed. */
  failTurn(error: Error): void {
    this.rejectTurn(error);
  }

  reset(): void {
    this.waitResolve?.();
    this.completeTurn({ ok: false, error: "session stopped" });
    this.waitResolve = null;
    this.waitPromise = null;
    this.released = false;
  }

  private rejectTurn(error: Error): void {
    const reject = this.turnReject;
    if (!reject) return;
    this.turnResolve = null;
    this.turnReject = null;
    reject(error);
  }
}
