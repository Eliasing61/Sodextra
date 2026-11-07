import { describe, expect, it } from "vitest";

import { runBacktest, type ValidationEnv } from "@sodextra/engine-core";
import type { Kline, PerpsSymbol, SpotSymbol } from "@sodextra/sodex-client";

import {
  buildLines,
  grid,
  nearestLine,
  parseGridConfig,
  planGrid,
  type GridState,
} from "../src/index.ts";

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
  marginTiers: [
    {
      maxNotionalValue: "4000000",
      maintenanceMarginRate: "0.0125",
      maxLeverage: 40,
      maintenanceDeduction: "0",
    },
    {
      maxNotionalValue: "100000000",
      maintenanceMarginRate: "0.02",
      maxLeverage: 25,
      maintenanceDeduction: "30000",
    },
  ],
  status: "TRADING",
};

const ETH_SPOT: SpotSymbol = {
  id: 2,
  name: "vETH_vUSDC",
  displayName: "ETH/USDC",
  baseCoinID: 2,
  baseCoin: "vETH",
  quoteCoinID: 0,
  quoteCoin: "vUSDC",
  pricePrecision: 1,
  tickSize: "0.1",
  minPrice: "0.1",
  maxPrice: "0",
  quantityPrecision: 4,
  stepSize: "0.0001",
  minQuantity: "0.0001",
  maxQuantity: "0",
  marketMinQuantity: "0.0001",
  marketMaxQuantity: "0",
  minNotional: "5",
  maxNotional: "0",
  buyLimitUpRatio: "1",
  sellLimitDownRatio: "0.5",
  marketDeviationRatio: "0.1",
  makerFee: "0.00035",
  takerFee: "0.00065",
  status: "TRADING",
};

const worked = parseGridConfig({
  type: "neutral",
  lower: 72000,
  upper: 84000,
  grids: 24,
  spacing: "arithmetic",
  investment: 200,
  leverage: 3,
  stopLoss: 70000,
});

const env = (overrides: Partial<ValidationEnv> = {}): ValidationEnv => ({
  symbol: BTC,
  market: "perps",
  markPrice: "77571",
  makerFee: "0.00012",
  takerFee: "0.0004",
  builderFee: "0",
  risk: {},
  ...overrides,
});

/** Candles that walk through `prices`, each opening at the previous close. */
function candles(prices: number[]): Kline[] {
  return prices.slice(1).map((p, i) => {
    const o = prices[i]!;
    return {
      t: i * 60_000,
      o: String(o),
      h: String(Math.max(o, p) + 1),
      l: String(Math.min(o, p) - 1),
      c: String(p),
      v: "1",
      q: "1",
    };
  });
}

const backtest = (
  rawConfig: Record<string, unknown>,
  prices: number[],
  symbol: PerpsSymbol | SpotSymbol = BTC,
  market: "perps" | "spot" = "perps",
) =>
  runBacktest({
    strategy: grid,
    config: parseGridConfig(rawConfig),
    market,
    symbol,
    candles: candles(prices),
    candleMs: 60_000,
    makerFee: market === "spot" ? "0.00035" : "0.00012",
    takerFee: market === "spot" ? "0.00065" : "0.0004",
    quoteBalance: "1000",
  });

describe("grid config", () => {
  it("applies defaults and routes stopLoss to the right side", () => {
    expect(worked).toMatchObject({
      type: "neutral",
      spacing: "arithmetic",
      onStop: "cancel_and_close",
      window: 20,
      stopLossLow: "70000",
    });
    expect(
      parseGridConfig({ type: "short", lower: 1, upper: 2, grids: 5, investment: 10, stopLoss: 3 })
        .stopLossHigh,
    ).toBe("3");
    expect(parseGridConfig({ lower: 100, upper: 200, grids: 5, investment: 10 }).spacing).toBe(
      "geometric",
    );
  });

  it.each([
    [{ lower: 2, upper: 1, grids: 5, investment: 10 }, /upper/],
    [{ lower: 1, upper: 2, grids: 101, investment: 10 }, /grids/],
    [{ lower: 1, upper: 2, grids: 5 }, /investment/],
    [{ lower: 1, upper: 2, grids: 5, investment: 10, leverage: 11 }, /leverage/],
    [{ lower: 1, upper: 2, grids: 5, investment: 10, type: "both" }, /type/],
  ])("rejects %j", (raw, error) => {
    expect(() => parseGridConfig(raw)).toThrow(error);
  });
});

describe("grid math", () => {
  it("reproduces the spec's worked example (§4.6)", () => {
    const p = planGrid({
      config: worked,
      symbol: BTC,
      market: "perps",
      price: "77571",
      makerFee: "0.00012",
      builderFee: "0",
    });
    expect(p.lines).toHaveLength(25);
    expect([p.lines[0], p.lines[1], p.lines[24]]).toEqual(["72000", "72500", "84000"]);
    expect(p.lines[p.gap]).toBe("77500");
    expect(p.buys).toHaveLength(11);
    expect(p.sells).toHaveLength(13);
    // Capacity 200 × 3 × 0.9 = 540 spread over the top 24 lines (sum 1,878,000) → 0.000287 → 0.00028.
    expect(p.quantity).toBe("0.00028");
    expect(p.grossPerGrid).toBe("0.14");
    expect(Number(p.netPerGrid)).toBeCloseTo(0.1344, 3);
    expect(p.long).toMatchObject({ size: "0.00308", avgEntry: "74500" });
    expect(p.short).toMatchObject({ size: "0.00364", avgEntry: "81000" });
    // Isolated margin = notional ÷ leverage (≈133.85), so liquidation ≈ 50,295 — far below the 70,000 stop.
    expect(Number(p.long.liquidation)).toBeCloseTo(50295, -1);
    expect(Number(p.short.liquidation)).toBeCloseTo(106667, -1);
    expect(Number(p.effectiveLeverage)).toBeCloseTo(1.53, 2); // short side: 0.00364 × 84,000 ÷ 200
  });

  it("builds geometric lines with equal % steps and flags merged lines", () => {
    const { lines } = buildLines(
      { lower: "100", upper: "400", grids: 2, spacing: "geometric" },
      BTC,
    );
    expect(lines).toEqual(["100", "200", "400"]);
    expect(
      buildLines({ lower: "100", upper: "110", grids: 5, spacing: "arithmetic" }, BTC).problems[0],
    ).toMatch(/closer than 5 ticks/);
    expect(nearestLine(["10", "20", "30"], "24")).toBe(1);
  });

  it("sizes long grids to buy the coins the sells will need", () => {
    const p = planGrid({
      config: { ...worked, type: "long", stopLossLow: undefined },
      symbol: BTC,
      market: "perps",
      price: "77571",
      makerFee: "0",
      builderFee: "0",
    });
    expect(p.start).toEqual({
      side: "BUY",
      quantity: (13 * Number(p.quantity)).toFixed(5).replace(/0+$/, ""),
    });
    expect(p.short.size).toBe("0");
  });
});

describe("grid validation", () => {
  it("accepts the worked example and prints the plan", () => {
    const r = grid.validate(worked, env());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const text = r.summary.join("\n");
    expect(text).toContain("11 buys, 13 sells, gap line 77500, 0.00028 BTC per order");
    expect(text).toContain("est. liquidation");
  });

  it("waits instead of refusing when the price is outside the range (a restart can find it there)", () => {
    for (const markPrice of ["90000", "70500"]) {
      const r = grid.validate(worked, env({ markPrice }));
      expect(r.errors).toEqual([]);
      expect(r.warnings.join()).toMatch(/waits until it moves inside/);
    }
  });

  it.each([
    ["perps grid on a spot market", { market: "spot" as const, symbol: ETH_SPOT }, /type/],
    ["leverage above the bot's limit", { risk: { maxLeverage: 2 } }, /risk.maxLeverage/],
    ["exposure above the bot's limit", { risk: { maxNotional: "100" } }, /risk.maxNotional/],
    [
      "too many open orders for the bot's limit",
      { risk: { maxOpenOrders: 10 } },
      /risk.maxOpenOrders/,
    ],
    ["not enough balance", { availableQuote: "50" }, /free in your SoDEX perps account/],
  ])("rejects %s", (_name, overrides, error) => {
    const r = grid.validate(worked, env(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(error);
  });

  it("rejects orders below SoDEX's minimum and gaps that don't cover fees", () => {
    const tooSmall = grid.validate(
      parseGridConfig({ lower: 72000, upper: 84000, grids: 100, investment: 20, leverage: 1 }),
      env(),
    );
    expect(tooSmall.errors.join()).toMatch(/minimum/);
    const tooTight = grid.validate(
      parseGridConfig({ lower: 77400, upper: 77700, grids: 50, investment: 5000, leverage: 1 }),
      env({ makerFee: "0.001" }),
    );
    expect(tooTight.errors.join()).toMatch(/doesn't cover fees/);
  });

  it("rejects a liquidation price too close to the stop", () => {
    const risky = parseGridConfig({
      lower: 72000,
      upper: 84000,
      grids: 24,
      investment: 200,
      leverage: 10,
      stopLoss: 71000,
    });
    expect(grid.validate(risky, env()).errors.join()).toMatch(/liquidation/);
  });
});

describe("grid in the engine (backtests)", () => {
  const sideways = { lower: 76000, upper: 78000, grids: 10, investment: 300, leverage: 2 };
  // Oscillates inside the range several times, ending where it started.
  const zigzag = [77000, 76500, 77500, 76500, 77500, 76500, 77500, 77000];

  it("earns round trips in a sideways market (neutral)", async () => {
    const r = await backtest(sideways, zigzag);
    const state = r.strategyState as GridState;
    expect(r.status).toBe("running");
    expect(state.phase).toBe("running");
    expect(state.roundTrips).toBeGreaterThanOrEqual(6);
    expect(Number(state.gridProfit)).toBeGreaterThan(0);
    expect(Number(r.realizedPnl)).toBeGreaterThan(0);
    expect(Number(r.totalPnl)).toBeGreaterThan(0);
    expect(r.finalPosition).toBe("0"); // back at the start price → flat
    expect(grid.describe!(parseGridConfig(sideways), state)[1]).toMatch(/round trips \d+/);
  });

  it("stops and closes when the price crashes through the stop-loss", async () => {
    const r = await backtest(
      { ...sideways, stopLoss: 75500 },
      [77000, 76500, 76000, 75800, 75400, 75000],
    );
    expect(r.status).toBe("stopped");
    expect(r.statusReason).toMatch(/stop-loss/);
    expect(r.finalPosition).toBe("0");
    expect(Number(r.realizedPnl)).toBeLessThan(0);
  });

  it("keeps its sells and waits when the price leaves the range without a stop", async () => {
    const r = await backtest(sideways, [77000, 76500, 76000, 75000, 74500]);
    const state = r.strategyState as GridState;
    expect(r.status).toBe("running");
    expect(state.outOfRange).toBe("below");
    expect(Number(r.finalPosition)).toBeGreaterThan(0); // all buys filled → fully long
  });

  it("long grid opens its starting position first, then sells it off as the price rises", async () => {
    const r = await backtest({ ...sideways, type: "long" }, [77000, 77300, 77600, 77900, 77950]);
    const state = r.strategyState as GridState;
    expect(state.start?.filled).toBe(state.start?.quantity);
    expect(Number(r.realizedPnl)).toBeGreaterThan(0);
    expect(Number(r.finalPosition)).toBeLessThan(Number(state.start!.quantity));
  });

  it("short grid opens a short and buys it back as the price falls", async () => {
    const r = await backtest({ ...sideways, type: "short" }, [77000, 76700, 76400, 76100, 76050]);
    const state = r.strategyState as GridState;
    expect(state.start?.side).toBe("SELL");
    expect(Number(r.realizedPnl)).toBeGreaterThan(0);
  });

  it("spot grid buys the coin it needs, then trades the range", async () => {
    const r = await backtest(
      { type: "spot", lower: 2000, upper: 2400, grids: 8, investment: 500 },
      [2200, 2150, 2250, 2150, 2250, 2200],
      ETH_SPOT,
      "spot",
    );
    const state = r.strategyState as GridState;
    expect(state.start?.side).toBe("BUY");
    expect(state.roundTrips).toBeGreaterThan(0);
    expect(r.status).toBe("running");
  });

  it("spot grid never sells more coin than it holds (SoDEX takes buy fees in the coin)", async () => {
    const r = await backtest(
      { type: "spot", lower: 2000, upper: 2400, grids: 8, investment: 500 },
      [2200, 2140, 2260, 2140, 2260, 2090, 2310, 2140, 2260, 2200],
      ETH_SPOT,
      "spot",
    );
    const state = r.strategyState as GridState;
    expect(state.roundTrips).toBeGreaterThan(3);
    expect(r.events.filter((e) => /insufficient/.test(e.message))).toEqual([]);
  });
});

describe("grid fill bookkeeping", () => {
  function ctx(overrides: Record<string, unknown> = {}) {
    const position = { value: 0 };
    return {
      position_: position,
      config: parseGridConfig({
        lower: 100,
        upper: 200,
        grids: 4,
        spacing: "arithmetic",
        investment: 1000,
        leverage: 1,
        ...overrides,
      }),
      symbol: BTC,
      market: "perps" as const,
      mode: "backtest" as const,
      now: () => 0,
      mark: () => "150",
      book: () => undefined,
      position: () => String(position.value),
      totalPnl: () => "0",
      volume: () => "0",
      runVolume: () => "0",
      actions: () => 0,
      log: () => {},
      requestStop: () => {},
    };
  }
  const fill = (side: "BUY" | "SELL", price: string) => ({
    tradeId: price,
    clOrdID: "x",
    side,
    price,
    quantity: "1",
    fee: "0",
    time: 0,
  });
  const order = (key: string, side: "BUY" | "SELL") => ({
    clOrdID: "x",
    key,
    side,
    kind: "limit" as const,
    filledQty: "1",
    quantity: "1",
    postOnly: true,
    reduceOnly: false,
    status: "filled" as const,
    createdAt: 0,
    updatedAt: 0,
  });

  const fillLine = (
    c: ReturnType<typeof ctx>,
    state: GridState,
    side: "BUY" | "SELL",
    price: string,
    key: string,
  ) => {
    c.position_.value += side === "BUY" ? 1 : -1;
    const q = state.quantity ?? "1";
    grid.onFill!(c, state, fill(side, price), { ...order(key, side), quantity: q, filledQty: q });
  };

  it("counts a round trip only when a fill closes inventory", () => {
    const c = { ...ctx(), mark: () => "190" };
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "190", time: 0 }); // gap at the top line (200)
    fillLine(c, state, "BUY", "175", "L003"); // opens a long → sell placed at 200
    fillLine(c, state, "SELL", "200", "L004"); // closes it → 1 round trip, buy placed back at 175
    fillLine(c, state, "BUY", "175", "L003"); // re-opens: NOT a round trip
    expect(state.roundTrips).toBe(1);
    expect(state.slots).toEqual(["BUY", "BUY", "BUY", null, "SELL"]);
  });

  it("places the counter order one line away and counts the round trip", () => {
    const c = ctx();
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 });
    expect(state.slots).toEqual(["BUY", "BUY", null, "SELL", "SELL"]); // lines 100 125 150 175 200
    fillLine(c, state, "BUY", "125", "L001");
    expect(state.slots).toEqual(["BUY", null, "SELL", "SELL", "SELL"]);
    fillLine(c, state, "SELL", "150", "L002");
    expect(state.slots).toEqual(["BUY", "BUY", null, "SELL", "SELL"]);
    expect(state.roundTrips).toBe(1);
    expect(Number(state.gridProfit)).toBeCloseTo(25 * Number(state.quantity), 10);
  });

  it("handles fills that arrive out of order without losing a counter order", () => {
    const c = ctx();
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 });
    // Price fell through both buys, but the lower fill is reported first.
    fillLine(c, state, "BUY", "100", "L000");
    expect(state.owed["1"]).toEqual({ side: "SELL", from: 0 });
    fillLine(c, state, "BUY", "125", "L001");
    expect(state.slots).toEqual([null, "SELL", "SELL", "SELL", "SELL"]);
    expect(state.owed).toEqual({});
  });

  it("only asks for the window of lines nearest the price", () => {
    const c = { ...ctx({ lower: 100, upper: 400, grids: 60, window: 5 }), mark: () => "250" };
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "250", time: 0 });
    expect(state.slots.filter(Boolean)).toHaveLength(60); // every line is tracked…
    const wanted = grid.desired(c, state);
    expect(wanted).toHaveLength(10); // …but only 5 per side rest on the book
    expect(wanted.every((o) => o.postOnly && o.onPostOnlyReject === "taker")).toBe(true);
  });

  it("asks for an exchange stop-loss only on the side the position is on", () => {
    const base = ctx({ stopLossLow: 90 });
    const state = grid.initialState(base);
    grid.onMarket!(base, state, { type: "mark", price: "150", time: 0 });
    expect(grid.desired(base, state).some((o) => o.kind === "stop")).toBe(false);
    const long = { ...base, position: () => "2" };
    expect(grid.desired(long, state).find((o) => o.kind === "stop")).toMatchObject({
      side: "SELL",
      stopPrice: "90",
      reduceOnly: true,
    });
    expect(grid.desired(long, state).find((o) => o.kind === "stop")?.quantity).toBeUndefined();
    // First in the list, so the open-order limit never drops the stop.
    expect(grid.desired(long, state)[0]?.kind).toBe("stop");
  });

  it("always runs cross margin, even for a file saved as isolated", () => {
    expect(grid.setup!(ctx({ marginMode: "isolated", leverage: 2 }))).toEqual({
      leverage: 2,
      marginMode: "CROSS",
    });
  });

  it("spot: each sell sells the coins its buy delivered, not the full order size", () => {
    const pos = { value: 0 };
    const c = {
      ...ctx({ type: "spot" }),
      market: "spot" as const,
      symbol: ETH_SPOT,
      position: () => String(pos.value),
    };
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 }); // sells at 175 and 200
    const q = Number(state.quantity);
    const start = String(2 * q);
    pos.value = 2 * q * 0.999; // the start buy delivers 2q less a 0.1% fee in the coin
    grid.onFill!(
      c,
      state,
      { ...fill("BUY", "150"), quantity: start },
      { ...order("start", "BUY"), quantity: start, filledQty: start },
    );
    const sells = () => grid.desired(c, state).filter((o) => o.side === "SELL");
    const total = () => sells().reduce((s, o) => s + Number(o.quantity), 0);
    expect(sells()).toHaveLength(2);
    expect(total()).toBeLessThanOrEqual(pos.value);

    pos.value += q * 0.9996; // a buy at 125 delivers q less its fee
    grid.onFill!(c, state, fill("BUY", "125"), order("L001", "BUY"));
    expect(sells()).toHaveLength(3);
    expect(total()).toBeLessThanOrEqual(pos.value);
    expect(Number(sells().find((o) => o.price === "150")!.quantity)).toBeLessThan(q);
  });

  it("spot: selling the starting coins counts as a round trip from the line below", () => {
    const pos = { value: 0 };
    const c = {
      ...ctx({ type: "spot" }),
      market: "spot" as const,
      symbol: ETH_SPOT,
      position: () => String(pos.value),
    };
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 }); // sells at 175 and 200
    const q = state.quantity!;
    const start = String(2 * Number(q));
    pos.value = Number(start);
    grid.onFill!(
      c,
      state,
      { ...fill("BUY", "150"), quantity: start },
      { ...order("start", "BUY"), quantity: start, filledQty: start },
    );
    pos.value -= Number(q);
    grid.onFill!(
      c,
      state,
      { ...fill("SELL", "175"), quantity: q },
      { ...order("L003", "SELL"), quantity: q, filledQty: q },
    );
    expect(state.roundTrips).toBe(1);
    expect(Number(state.gridProfit)).toBeCloseTo(25 * Number(q), 10);
    expect(state.slots[2]).toBe("BUY"); // its counter buy, one line down
  });

  it("short: buying back the starting short counts as a round trip from the line above", () => {
    const c = ctx({ type: "short" });
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 }); // buys at 100 and 125
    expect(state.start?.side).toBe("SELL");
    c.position_.value = -2;
    grid.onFill!(
      c,
      state,
      { ...fill("SELL", "150"), quantity: state.start!.quantity },
      {
        ...order("start", "SELL"),
        quantity: state.start!.quantity,
        filledQty: state.start!.quantity,
      },
    );
    fillLine(c, state, "BUY", "125", "L001");
    expect(state.roundTrips).toBe(1);
    expect(Number(state.gridProfit)).toBeCloseTo(25 * Number(state.quantity), 10);
  });

  it("ignores partial fills until the order is complete", () => {
    const c = ctx();
    const state = grid.initialState(c);
    grid.onMarket!(c, state, { type: "mark", price: "150", time: 0 });
    grid.onFill!(c, state, fill("BUY", "125"), {
      ...order("L001", "BUY"),
      status: "partially_filled" as const,
    });
    expect(state.slots[1]).toBe("BUY");
  });
});

describe("grid start", () => {
  it("waits for the price to enter the range instead of giving up", async () => {
    const r = await runBacktest({
      strategy: grid,
      config: parseGridConfig({
        lower: 76000,
        upper: 78000,
        grids: 10,
        investment: 300,
        leverage: 2,
      }),
      market: "perps",
      symbol: BTC,
      candles: [79000, 78600, 78100, 77700, 77300, 76900, 77400].slice(1).map((p, i, all) => {
        const o = i === 0 ? 79000 : all[i - 1]!;
        return {
          t: i * 60_000,
          o: String(o),
          h: String(Math.max(o, p) + 1),
          l: String(Math.min(o, p) - 1),
          c: String(p),
          v: "1",
          q: "1",
        };
      }),
      candleMs: 60_000,
      makerFee: "0.00012",
      takerFee: "0.0004",
      quoteBalance: "1000",
    });
    const state = r.strategyState as GridState;
    expect(r.status).toBe("running");
    expect(state.phase).toBe("running");
    expect(state.lines).toHaveLength(11);
    expect(r.fills).toBeGreaterThan(0);
  });
});
