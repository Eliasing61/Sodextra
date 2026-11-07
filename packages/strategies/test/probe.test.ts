import { describe, expect, it } from "vitest";

import { runBacktest } from "@sodextra/engine-core";
import type { Kline, PerpsSymbol } from "@sodextra/sodex-client";

import { probe } from "../src/index.ts";

const BTC: PerpsSymbol = {
  id: 1,
  name: "BTC-USD",
  displayName: "BTC-USD",
  baseCoin: "BTC",
  quoteCoinID: 0,
  pricePrecision: 0,
  tickSize: "1",
  minPrice: "1",
  maxPrice: "0",
  quantityPrecision: 5,
  stepSize: "0.00001",
  minQuantity: "0.00001",
  maxQuantity: "0",
  marketMinQuantity: "0.00001",
  marketMaxQuantity: "0",
  minNotional: "10",
  maxNotional: "4000000",
  buyLimitUpRatio: "0.05",
  sellLimitDownRatio: "0.05",
  marketDeviationRatio: "0.025",
  maxLeverage: 40,
  initLeverage: 20,
  marginTiers: [],
  status: "TRADING",
};

const env = {
  symbol: BTC,
  market: "perps" as const,
  markPrice: "77000",
  makerFee: "0.00012",
  takerFee: "0.0004",
  builderFee: "0",
  risk: {},
};

function candles(prices: number[]): Kline[] {
  return prices.map((p, i) => ({
    t: i * 60_000,
    o: String(p),
    h: String(p + 50),
    l: String(p - 50),
    c: String(p),
    v: "1",
    q: "1",
  }));
}

describe("probe strategy", () => {
  it("parses defaults and rejects bad settings", () => {
    expect(probe.parseConfig({})).toEqual({
      side: "BUY",
      offsetPct: 3,
      repriceAtPct: 1,
      quantity: undefined,
    });
    expect(() => probe.parseConfig({ side: "LONG" })).toThrow();
    expect(probe.validate(probe.parseConfig({ offsetPct: 6 }), env).ok).toBe(false);
    expect(probe.validate(probe.parseConfig({ repriceAtPct: 3 }), env).ok).toBe(false);
  });

  it("validates a minimum-size order 3% below mark", () => {
    const result = probe.validate(probe.parseConfig({}), env);
    expect(result.ok).toBe(true);
    expect(result.summary.join("\n")).toContain("post-only BUY 0.00014 @ 74690");
  });

  it("honours the notional cap in validation", () => {
    const result = probe.validate(probe.parseConfig({ quantity: "0.01" }), {
      ...env,
      risk: { maxNotional: "50" },
    });
    expect(result.errors.join()).toMatch(/risk.maxNotional/);
  });

  it("rests without filling and re-prices when the market drifts (backtest)", async () => {
    const path = [77000, 77100, 77200, 78000, 78100, 79000, 79100];
    const report = await runBacktest({
      strategy: probe,
      config: probe.parseConfig({}),
      market: "perps",
      symbol: BTC,
      candles: candles(path),
      candleMs: 60_000,
      makerFee: "0.00012",
      takerFee: "0.0004",
      quoteBalance: "1000",
    });
    expect(report.fills).toBe(0);
    expect(report.totalPnl).toBe("0");
    expect(report.status).toBe("running");
    expect(report.events.length).toBe(0);
  });

  it("stops itself if its order ever fills (backtest crash scenario)", async () => {
    const report = await runBacktest({
      strategy: probe,
      config: probe.parseConfig({}),
      market: "perps",
      symbol: BTC,
      candles: candles([77000, 77000, 74000, 74000]),
      candleMs: 60_000,
      makerFee: "0.00012",
      takerFee: "0.0004",
      quoteBalance: "1000",
    });
    expect(report.fills).toBe(1);
    expect(report.status).toBe("stopped");
    expect(report.finalPosition).toBe("0.00014");
  });
});
