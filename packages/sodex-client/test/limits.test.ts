import { describe, expect, it } from "vitest";

import {
  NonceManager,
  OrderRateLimiter,
  SlidingWindowLimiter,
  WeightLimiter,
} from "../src/index.ts";

/** Fake clock whose sleep advances time instantly. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("NonceManager", () => {
  it("uses the clock and stays strictly increasing within one millisecond", () => {
    const clock = fakeClock(1760373925000);
    const nonces = new NonceManager(clock.now);
    expect(nonces.next("0xAbC")).toBe(1760373925000n);
    expect(nonces.next("0xabc")).toBe(1760373925001n);
    expect(nonces.next("0xdef")).toBe(1760373925000n);
    clock.advance(10);
    expect(nonces.next("0xabc")).toBe(1760373925010n);
  });
});

describe("WeightLimiter", () => {
  it("waits for the next window once the budget is used", async () => {
    const clock = fakeClock();
    const limiter = new WeightLimiter({ limit: 100, safety: 1, ...clock });
    await limiter.acquire(60);
    await limiter.acquire(40);
    const before = clock.now();
    await limiter.acquire(10);
    expect(clock.now() - before).toBeGreaterThanOrEqual(60_000);
    expect(limiter.used).toBe(10);
  });

  it("adopts the gateway's x-ratelimit headers", async () => {
    const clock = fakeClock(1_793_418_700_000);
    const limiter = new WeightLimiter({ limit: 1200, safety: 0.8, ...clock });
    await limiter.acquire(1);
    limiter.syncFromHeaders(
      new Headers({
        "x-ratelimit-limit": "6000",
        "x-ratelimit-remaining": "5953",
        "x-ratelimit-reset": "1793418780",
      }),
    );
    expect(limiter.budget).toBe(4800);
    expect(limiter.used).toBe(47);
  });

  it("refuses a single request heavier than the whole budget", async () => {
    await expect(new WeightLimiter({ limit: 10, safety: 1 }).acquire(11)).rejects.toThrow();
  });
});

describe("order rate limits", () => {
  it("allows 20 orders per second, then waits", async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(20, 1000, clock);
    await limiter.acquire(20);
    const before = clock.now();
    await limiter.acquire(1);
    expect(clock.now() - before).toBeGreaterThanOrEqual(1000);
  });

  it("tracks accounts independently", async () => {
    const clock = fakeClock();
    const limiter = new OrderRateLimiter(clock);
    await limiter.acquire("1", 20);
    const before = clock.now();
    await limiter.acquire("2", 20);
    expect(clock.now()).toBe(before);
  });
});
