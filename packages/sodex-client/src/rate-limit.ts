// Local limiters that keep us under SoDEX's limits instead of finding them by
// getting rejected. In-memory for single-process use; the server version will
// share these budgets across processes through Redis.

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * REST request-weight budget per IP over a 60 s window.
 * Docs say 1200/min; the gateway's x-ratelimit-* headers report the live figure,
 * and `syncFromHeaders` adopts it. `safety` keeps headroom for other tools on the same IP.
 */
export class WeightLimiter {
  #limit: number;
  #used = 0;
  #windowEnd = 0;
  readonly #safety: number;
  readonly #now: () => number;
  readonly #sleep: Sleep;

  constructor(
    options: { limit?: number; safety?: number; now?: () => number; sleep?: Sleep } = {},
  ) {
    this.#limit = options.limit ?? 1200;
    this.#safety = options.safety ?? 0.8;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get budget(): number {
    return Math.floor(this.#limit * this.#safety);
  }

  get used(): number {
    this.#roll();
    return this.#used;
  }

  async acquire(weight: number): Promise<void> {
    if (weight > this.budget)
      throw new Error(`Request weight ${weight} exceeds the whole budget ${this.budget}`);
    for (;;) {
      this.#roll();
      if (this.#used + weight <= this.budget) {
        this.#used += weight;
        return;
      }
      await this.#sleep(Math.max(this.#windowEnd - this.#now(), 50));
    }
  }

  /** Adopt the gateway's view: x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset (epoch seconds). */
  syncFromHeaders(headers: { get(name: string): string | null }): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return;
    this.#limit = limit;
    this.#used = Math.max(this.#used, limit - remaining);
    if (Number.isFinite(reset) && reset > 0) this.#windowEnd = reset * 1000;
  }

  #roll(): void {
    const now = this.#now();
    if (now >= this.#windowEnd) {
      this.#used = 0;
      this.#windowEnd = now + 60_000;
    }
  }
}

/** Sliding-window counter, e.g. 20 orders per second and 600 per minute per account. */
export class SlidingWindowLimiter {
  readonly #events: number[] = [];
  readonly #now: () => number;
  readonly #sleep: Sleep;

  constructor(
    readonly max: number,
    readonly windowMs: number,
    options: { now?: () => number; sleep?: Sleep } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async acquire(count = 1): Promise<void> {
    if (count > this.max)
      throw new Error(`Cannot take ${count} at once; window max is ${this.max}`);
    for (;;) {
      const now = this.#now();
      while (this.#events.length > 0 && this.#events[0]! <= now - this.windowMs)
        this.#events.shift();
      if (this.#events.length + count <= this.max) {
        for (let i = 0; i < count; i++) this.#events.push(now);
        return;
      }
      const oldest = this.#events[this.#events.length + count - this.max - 1]!;
      await this.#sleep(Math.max(oldest + this.windowMs - now, 1));
    }
  }
}

/** Per-account order placement limits for API-key clients: 20/s and 600/min. */
export class OrderRateLimiter {
  readonly #perAccount = new Map<string, [SlidingWindowLimiter, SlidingWindowLimiter]>();

  constructor(private readonly options: { now?: () => number; sleep?: Sleep } = {}) {}

  async acquire(accountID: string, orders: number): Promise<void> {
    let limiters = this.#perAccount.get(accountID);
    if (!limiters) {
      limiters = [
        new SlidingWindowLimiter(20, 1_000, this.options),
        new SlidingWindowLimiter(600, 60_000, this.options),
      ];
      this.#perAccount.set(accountID, limiters);
    }
    await limiters[1].acquire(orders);
    await limiters[0].acquire(orders);
  }
}
