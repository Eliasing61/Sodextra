import type { BotEngine } from "./engine.ts";

export interface RunnerOptions {
  /** Safety-net timer: how often to check for queued events if a wake-up was missed. */
  tickMs?: number;
  /** Run a cycle at least this often even without events (time-based strategy logic). */
  idleCycleMs?: number;
  /** Minimum gap between event-driven cycles, so a burst of book updates is handled in one go. */
  minCycleGapMs?: number;
  /** Full comparison with the exchange (orders, missed fills, drift). */
  reconcileMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Drives an engine on real time (live and paper). Every queued event wakes the
 * runner, which cycles as soon as the minimum gap allows; that keeps quotes
 * fresh without spinning. Backtests call the engine directly.
 */
export class BotRunner {
  readonly #engine: BotEngine<unknown, unknown>;
  readonly #o: Required<Omit<RunnerOptions, "onError">> & Pick<RunnerOptions, "onError">;
  #tick: ReturnType<typeof setInterval> | undefined;
  #reconcile: ReturnType<typeof setInterval> | undefined;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCycle = 0;
  #running = false;
  #stopped = false;

  constructor(
    engine: BotEngine<never, never> | BotEngine<unknown, unknown>,
    options: RunnerOptions = {},
  ) {
    this.#engine = engine as BotEngine<unknown, unknown>;
    this.#o = {
      tickMs: 250,
      idleCycleMs: 5_000,
      minCycleGapMs: 25,
      reconcileMs: 30_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    this.#engine.setWakeHandler(() => this.#wake());
    await this.#engine.start();
    this.#lastCycle = Date.now();
    this.#tick = setInterval(() => void this.#maybeCycle(), this.#o.tickMs);
    this.#reconcile = setInterval(
      () => void this.#guard(() => this.#engine.reconcile()),
      this.#o.reconcileMs,
    );
  }

  /** Stop the timers and disconnect (quoting strategies cancel their quotes first). */
  async detach(): Promise<void> {
    this.#stopped = true;
    this.#engine.setWakeHandler(undefined);
    clearInterval(this.#tick);
    clearInterval(this.#reconcile);
    clearTimeout(this.#wakeTimer);
    await this.#engine.detach();
  }

  #wake(): void {
    if (this.#stopped || this.#wakeTimer !== undefined) return;
    const wait = Math.max(0, this.#lastCycle + this.#o.minCycleGapMs - Date.now());
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      void this.#maybeCycle();
    }, wait);
  }

  async #maybeCycle(): Promise<void> {
    if (this.#running || this.#stopped) return;
    const due = Date.now() - this.#lastCycle >= this.#o.idleCycleMs;
    if (!this.#engine.hasPendingEvents && !due) return;
    this.#running = true;
    this.#lastCycle = Date.now();
    await this.#guard(() => this.#engine.cycle());
    this.#running = false;
    // Events that arrived during the cycle get their own cycle right after.
    if (this.#engine.hasPendingEvents) this.#wake();
  }

  async #guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.#o.onError?.(error);
    }
  }
}
