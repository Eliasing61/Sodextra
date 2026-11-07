import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BacktestExchange,
  BinanceFeed,
  binanceSymbol,
  withReference,
  type FeedSocket,
  type MarketEvent,
} from "../src/index.ts";
import { BTC } from "./helpers.ts";

/** Fake sockets: the test opens, feeds and closes them. */
function sockets() {
  const made: { url: string; fire: (type: string, data?: unknown) => void; closed: boolean }[] = [];
  const factory = (url: string): FeedSocket => {
    const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    const s = {
      url,
      closed: false,
      fire: (type: string, data?: unknown) => {
        for (const fn of listeners[type] ?? []) fn({ data });
      },
    };
    made.push(s);
    return {
      close: () => {
        s.closed = true;
      },
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
      },
    };
  };
  return { made, factory };
}

const depth = (bid: string, ask: string) =>
  JSON.stringify({ e: "depthUpdate", b: [[bid, "1"]], a: [[ask, "2"]] });

describe("BinanceFeed", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("reads the best prices from the throttled public stream, once per change", () => {
    const { made, factory } = sockets();
    const prices: string[] = [];
    const feed = new BinanceFeed("BTCUSDT", factory);
    feed.start((bid, ask) => prices.push(`${bid}/${ask}`));
    expect(made[0]!.url).toBe("wss://fstream.binance.com/public/ws/btcusdt@depth5@100ms");
    made[0]!.fire("open");
    made[0]!.fire("message", depth("80000.1", "80000.2"));
    made[0]!.fire("message", depth("80000.1", "80000.2")); // sizes moved only
    made[0]!.fire("message", depth("80000.0", "80000.2"));
    made[0]!.fire("message", "not json");
    expect(prices).toEqual(["80000.1/80000.2", "80000.0/80000.2"]);
    feed.stop();
  });

  it("backs off after failures, within Binance's 300 attempts per IP per 5 minutes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const { made, factory } = sockets();
    const warnings: string[] = [];
    const feed = new BinanceFeed("BTCUSDT", factory);
    feed.start(
      () => {},
      (m) => warnings.push(m),
    );
    // Each attempt fails at once (say, a restricted location).
    const gaps: number[] = [];
    let at = Date.now();
    for (let i = 0; i < 8; i++) {
      made.at(-1)!.fire("close");
      const before = made.length;
      while (made.length === before) vi.advanceTimersByTime(1_000);
      gaps.push((Date.now() - at) / 1000);
      at = Date.now();
    }
    expect(gaps).toEqual([5, 15, 30, 60, 120, 300, 300, 300]);
    // About 19 minutes of failures: warned at most once per 10 minutes, not on every attempt.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/Binance prices for BTCUSDT unavailable .* trading on the timer/);
    feed.stop();
    vi.restoreAllMocks();
  });

  it("reopens at once after Binance's planned 24-hour close, and starts the backoff over", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { made, factory } = sockets();
    const feed = new BinanceFeed("BTCUSDT", factory);
    feed.start(() => {});
    made[0]!.fire("open");
    // Keep it fed for 23 h so the watchdog stays quiet.
    for (let h = 0; h < 23 * 180; h++) {
      vi.advanceTimersByTime(20_000);
      made[0]!.fire("message", depth("1", "2"));
    }
    made[0]!.fire("close");
    vi.advanceTimersByTime(1_000);
    expect(made).toHaveLength(2);
    feed.stop();
    vi.restoreAllMocks();
  });

  it("drops a connection that has gone silent for 30 s and opens a new one", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { made, factory } = sockets();
    const feed = new BinanceFeed("BTCUSDT", factory);
    feed.start(() => {});
    made[0]!.fire("open");
    vi.advanceTimersByTime(35_000);
    expect(made[0]!.closed).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(made).toHaveLength(2);
    feed.stop();
    vi.restoreAllMocks();
  });

  it("stays closed once stopped", () => {
    const { made, factory } = sockets();
    const feed = new BinanceFeed("BTCUSDT", factory);
    feed.start(() => {});
    feed.stop();
    made[0]!.fire("close");
    vi.advanceTimersByTime(600_000);
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(true);
  });

  it("names SoDEX perps on Binance", () => {
    expect(binanceSymbol("BTC-USD")).toBe("BTCUSDT");
    expect(binanceSymbol("vBTC_vUSDC")).toBeUndefined();
  });

  it("adds the feed's prices to the exchange's events, as ref events only", async () => {
    vi.useRealTimers();
    const { made, factory } = sockets();
    const exchange = new BacktestExchange({
      market: "perps",
      symbol: BTC,
      makerFee: "0",
      takerFee: "0",
      quoteBalance: "100",
      startTime: 0,
    });
    const events: MarketEvent[] = [];
    const wrapped = withReference(exchange, new BinanceFeed("BTCUSDT", factory));
    await wrapped.start({
      onMarket: (e) => events.push(e),
      onAccount: () => {},
      onResync: () => {},
    });
    made[0]!.fire("message", depth("80000", "80001"));
    expect(events.at(-1)).toMatchObject({ type: "ref", bid: "80000", ask: "80001" });
    // Everything else is the exchange's own.
    expect(wrapped.market).toBe("perps");
    expect(typeof wrapped.replace).toBe(typeof exchange.replace);
    await wrapped.stop();
    expect(made[0]!.closed).toBe(true);
  });
});
