import { SqliteStore, type BotRecord, type Fill } from "@sodextra/engine-core";
import type { GridState } from "@sodextra/strategies";
import { describe, expect, it } from "vitest";

import { bars, botView, listItem, periods, sessionViews, type ViewContext } from "../src/views.ts";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const MIN = 60_000;

function fill(i: number, side: "BUY" | "SELL", price: string, minutesAgo: number): Fill {
  return {
    tradeId: `t${i}`,
    clOrdID: `sxm-bot-${i}`,
    side,
    price,
    quantity: "0.001",
    fee: "0.01",
    isMaker: true,
    time: NOW - minutesAgo * MIN,
  };
}

function setup() {
  const store = new SqliteStore(":memory:");
  const bot: BotRecord = {
    id: "b1",
    name: "maker-btc",
    strategy: "maker",
    symbol: "BTC-USD",
    market: "perps",
    mode: "paper",
    config: { orderSize: 12, levels: 1, maxInventory: 36, leverage: 3 },
    status: "running",
    createdAt: NOW - 90 * MIN,
    updatedAt: NOW,
  };
  store.createBot(bot);
  const ctx: ViewContext = { now: NOW, mark: () => "10010", online: () => true };
  return { store, bot, ctx };
}

describe("bars", () => {
  it("uses 5-minute bars for a young bot and attributes realised cost to the closing bar", () => {
    const fills = [fill(1, "BUY", "10000", 30), fill(2, "SELL", "10005", 12)];
    const { bars: out, barMs } = bars(fills, NOW);
    expect(barMs).toBe(5 * MIN);
    expect(out).toHaveLength(24);

    const withFills = out.filter((b) => b.fills > 0);
    expect(withFills).toHaveLength(2);
    // Opening bar: only its fee, 0.01 on $10 notional = 10 bp.
    expect(withFills[0]!.volume).toBeCloseTo(10);
    expect(withFills[0]!.costBps).toBeCloseTo(10);
    // Closing bar: +0.005 realised − 0.01 fee on $10.005 → cost ≈ 5 bp.
    expect(withFills[1]!.costBps).toBeCloseTo((0.005 / 10.005) * 10_000, 3);
    expect(out.find((b) => b.fills === 0)!.costBps).toBeNull();
  });

  it("widens bars to hours once the bot has traded for more than 12 hours", () => {
    const { barMs } = bars([fill(1, "BUY", "10000", 20 * 60)], NOW);
    expect(barMs).toBe(60 * MIN);
  });

  it("shows only the current run: a new run starts its own 5-minute bars", () => {
    // The last run traded all day and stopped at 11:46; this one started at 11:50.
    const fills = [
      fill(1, "BUY", "10000", 20 * 60),
      fill(2, "SELL", "10005", 20),
      fill(3, "BUY", "10000", 14),
      fill(4, "SELL", "10005", 5),
    ];
    const { bars: out, barMs } = bars(fills, NOW, NOW - 10 * MIN);
    expect(barMs).toBe(5 * MIN);
    expect(out.reduce((sum, b) => sum + b.fills, 0)).toBe(1);
    expect(out.reduce((sum, b) => sum + b.volume, 0)).toBeCloseTo(10.005);
  });
});

describe("botView", () => {
  it("builds metrics from the engine state, fills and risk copy", () => {
    const { store, bot, ctx } = setup();
    store.addFill(bot.id, fill(1, "BUY", "10000", 30));
    store.addFill(bot.id, fill(2, "SELL", "10005", 12));
    store.setKV(bot.id, "engine", {
      position: {
        size: "0",
        avgEntry: "0",
        realizedPnl: "0.005",
        fees: "0.02",
        volume: "20.005",
        fillCount: 2,
      },
      stats: { actions: 10, makerVolume: "20.005", takerVolume: "0" },
    });
    store.setKV(bot.id, "risk", { maxNotional: "70", maxLoss: "3", maxOpenOrders: 4 });

    const v = botView(store, bot, ctx);
    expect(v.online).toBe(true);
    expect(v.config).toEqual({ orderSize: 12, levels: 1, maxInventory: 36, leverage: 3 });
    expect(v.risk).toEqual({ maxNotional: 70, maxLoss: 3, maxOpenOrders: 4 });
    expect(v.metrics.makerShare).toBe(1);
    expect(v.metrics.pnl).toBeCloseTo(-0.015);
    expect(v.metrics.costPerMillion).toBeCloseTo((0.015 / 20.005) * 1_000_000);
    expect(v.metrics.actionsPerDollar).toBeCloseTo(10 / 20.005);
    expect(v.metrics.volumeToday).toBeCloseTo(20.005);
    expect(v.metrics.fills24h).toBe(2);
    expect(v.fills.map((f) => f.id)).toEqual(["t2", "t1"]);
    expect(v.metrics.actionBudget).toBeNull();
  });

  it("reports an empty bot without NaNs", () => {
    const { store, bot, ctx } = setup();
    const v = botView(store, bot, ctx);
    expect(v.metrics.costPerMillion).toBeNull();
    expect(v.metrics.makerShare).toBeNull();
    expect(v.metrics.actionsPerDollar).toBeNull();
    expect(v.risk).toBeNull();
    expect(v.bars.every((b) => b.volume === 0)).toBe(true);
    expect(listItem(store, bot, ctx).pnl).toBeNull();
  });

  it("marks a bot taken off the dashboard's list, and only then", () => {
    const { store, bot, ctx } = setup();
    expect(listItem(store, bot, ctx).hidden).toBeUndefined();
    store.setKV(bot.id, "hidden", true);
    expect(listItem(store, bot, ctx).hidden).toBe(true);
    store.setKV(bot.id, "hidden", false);
    expect(listItem(store, bot, ctx).hidden).toBeUndefined();
  });

  it("says whether a smart-timing Taker Volume bot is following Binance", () => {
    const { store, ctx } = setup();
    const bot: BotRecord = {
      id: "tk1",
      name: "taker-btc",
      strategy: "taker",
      symbol: "BTC-USD",
      market: "perps",
      mode: "live",
      config: { orderSize: "100", roundSec: 15, smartTiming: true, leverage: 5 },
      status: "running",
      createdAt: NOW - 10 * MIN,
      updatedAt: NOW,
    };
    store.createBot(bot);
    expect(botView(store, bot, ctx).config.smartTiming).toBe(true);
    expect(botView(store, bot, ctx).followingBinance).toBe(false);
    store.setKV(bot.id, "strategy", { seq: 4, rounds: 2, smart: { mode: "following" } });
    expect(botView(store, bot, ctx).followingBinance).toBe(true);
    // A maker bot has neither.
    const maker = botView(store, setup().bot, ctx);
    expect(maker.config.smartTiming).toBeUndefined();
    expect(maker.followingBinance).toBeUndefined();
  });
});

describe("grid bots", () => {
  function gridSetup() {
    const store = new SqliteStore(":memory:");
    const bot: BotRecord = {
      id: "g1",
      name: "grid-btc",
      strategy: "grid",
      symbol: "BTC-USD",
      market: "perps",
      mode: "live",
      // The parsed config the store keeps: decimals as strings.
      config: {
        type: "long",
        lower: "90000",
        upper: "110000",
        grids: 4,
        spacing: "arithmetic",
        investment: "250",
        leverage: 3,
        stopLossLow: "85000",
        onStop: "cancel_and_close",
        window: 4,
      },
      status: "running",
      createdAt: NOW - 90 * MIN,
      updatedAt: NOW,
    };
    store.createBot(bot);
    const ctx: ViewContext = { now: NOW, mark: () => "100500", online: () => true };
    return { store, bot, ctx };
  }

  it("shows the grid's settings, lines, slots and results", () => {
    const { store, bot, ctx } = gridSetup();
    const state: GridState = {
      phase: "running",
      lines: ["90000", "95000", "100000", "105000", "110000"],
      quantity: "0.0007",
      slots: ["BUY", "BUY", null, "SELL", "SELL"],
      owed: {},
      pairedWith: {},
      roundTrips: 3,
      gridProfit: "10.5",
      outOfRange: undefined,
    };
    store.setKV(bot.id, "strategy", state);

    const v = botView(store, bot, ctx);
    expect(v.config).toEqual({
      type: "long",
      lower: 90000,
      upper: 110000,
      grids: 4,
      spacing: "arithmetic",
      investment: 250,
      leverage: 3,
      stopLossLow: 85000,
      window: 4,
    });
    expect(v.grid).toEqual({
      phase: "running",
      lines: [90000, 95000, 100000, 105000, 110000],
      slots: ["BUY", "BUY", null, "SELL", "SELL"],
      quantity: 0.0007,
      roundTrips: 3,
      gridProfit: 10.5,
      outOfRange: null,
      waitingForRange: false,
      start: null,
    });
    expect(v.carry).toBeUndefined();
  });

  it("shows the starting position while it opens, and the price out of range", () => {
    const { store, bot, ctx } = gridSetup();
    store.setKV(bot.id, "strategy", {
      phase: "opening",
      slots: [],
      owed: {},
      pairedWith: {},
      start: { side: "BUY", quantity: "0.0014", filled: "0.0007", attempts: 1 },
      roundTrips: 0,
      gridProfit: "0",
      outOfRange: "above",
    } satisfies GridState);
    const grid = botView(store, bot, ctx).grid!;
    expect(grid.phase).toBe("opening");
    expect(grid.start).toEqual({ side: "BUY", quantity: 0.0014, filled: 0.0007 });
    expect(grid.outOfRange).toBe("above");
    expect(grid.lines).toEqual([]);
    expect(grid.quantity).toBeNull();
  });

  it("shows a grid that hasn't saved its state yet as waiting", () => {
    const { store, bot, ctx } = gridSetup();
    expect(botView(store, bot, ctx).grid).toEqual({
      phase: "waiting",
      lines: [],
      slots: [],
      quantity: null,
      roundTrips: 0,
      gridProfit: 0,
      outOfRange: null,
      waitingForRange: false,
      start: null,
    });
  });

  it("gives a stop-loss order its stop price, and other bots no grid", () => {
    const { store, bot, ctx } = gridSetup();
    store.saveOrder(bot.id, {
      clOrdID: "sxg-g1-1",
      key: "SL",
      side: "SELL",
      kind: "stop",
      quantity: "0.0014",
      filledQty: "0",
      postOnly: false,
      reduceOnly: true,
      stopPrice: "85000",
      stopType: "STOP_LOSS",
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.saveOrder(bot.id, {
      clOrdID: "sxg-g1-2",
      key: "L001",
      side: "BUY",
      kind: "limit",
      price: "95000",
      quantity: "0.0007",
      filledQty: "0",
      postOnly: true,
      reduceOnly: false,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW + 1,
    });
    const orders = botView(store, bot, ctx).orders;
    expect(orders).toEqual([
      {
        key: "SL",
        side: "SELL",
        kind: "stop",
        price: null,
        stopPrice: 85000,
        quantity: 0.0014,
        status: "open",
        postOnly: false,
      },
      {
        key: "L001",
        side: "BUY",
        kind: "limit",
        price: 95000,
        stopPrice: null,
        quantity: 0.0007,
        status: "open",
        postOnly: true,
      },
    ]);

    const maker = setup();
    expect(botView(maker.store, maker.bot, maker.ctx).grid).toBeUndefined();
  });
});

describe("listItem run", () => {
  it("shows only the current run, not earlier runs under the same name", () => {
    const { store, bot, ctx } = setup();
    const first = store.startSession(bot.id, NOW - 60 * MIN);
    store.addFill(bot.id, fill(1, "BUY", "10000", 50));
    store.addFill(bot.id, fill(2, "SELL", "10005", 45));
    store.endSession(first, NOW - 40 * MIN, "stopped: from the dashboard");
    store.startSession(bot.id, NOW - 20 * MIN);
    store.addFill(bot.id, fill(3, "BUY", "10010", 10));

    const run = listItem(store, bot, ctx).run!;
    expect(run.since).toBe(NOW - 20 * MIN);
    expect(run.fills).toBe(1);
    expect(run.volume).toBeCloseTo(10.01);
    expect(run.fees).toBeCloseTo(0.01);
  });

  it("starts each new run flat, even when an earlier run's close never reached the history", () => {
    const { store, bot, ctx } = setup();
    // Run 1 sells (a short); the market close at its stop is missing from the history.
    const first = store.startSession(bot.id, NOW - 60 * MIN);
    store.addFill(bot.id, fill(1, "SELL", "10000", 50));
    store.endSession(first, NOW - 40 * MIN, "stopped: from the dashboard");
    // Run 2 starts flat (the engine logs it), buys at 10100 and sells at 10120.
    store.startSession(bot.id, NOW - 30 * MIN);
    store.addEvent(bot.id, {
      time: NOW - 30 * MIN,
      level: "info",
      type: "new-run",
      message: "Starting a new run (the previous run was stopped)",
    });
    store.addFill(bot.id, fill(2, "BUY", "10100", 20));
    store.addFill(bot.id, fill(3, "SELL", "10120", 10));

    const run = listItem(store, bot, ctx).run!;
    // 0.001 × (10120 − 10100) = 0.02, less two 0.01 fees. Without the reset the buy
    // "closed" run 1's short at a 0.10 loss.
    expect(run.pnl).toBeCloseTo(0);
    expect(run.fills).toBe(2);
  });

  it("shows today (UTC) apart from the run and all time", () => {
    const { store, bot, ctx } = setup();
    store.startSession(bot.id, NOW - 14 * 60 * MIN); // yesterday, 22:00
    store.addFill(bot.id, fill(1, "BUY", "10000", 13 * 60)); // 23:00 yesterday
    store.addFill(bot.id, fill(2, "SELL", "10005", 30)); // today

    const item = listItem(store, bot, ctx);
    expect(item.run!.fills).toBe(2);
    expect(item.today!.since).toBe(Date.UTC(2026, 9, 31));
    expect(item.today!.fills).toBe(1);
    expect(item.today!.volume).toBeCloseTo(10.005);
  });
});

describe("sessionViews", () => {
  it("splits fills between runs and marks the current one running", () => {
    const { store, bot, ctx } = setup();
    const first = store.startSession(bot.id, NOW - 60 * MIN);
    store.addFill(bot.id, fill(1, "BUY", "10000", 50));
    store.addFill(bot.id, fill(2, "SELL", "10005", 45));
    store.endSession(first, NOW - 40 * MIN, "stopped: from the dashboard");
    store.startSession(bot.id, NOW - 20 * MIN);
    store.addFill(bot.id, fill(3, "BUY", "10010", 10));

    const [current, past] = sessionViews(store, [bot], ctx);
    expect(current).toMatchObject({ running: true, endedAt: null, fills: 1 });
    expect(past).toMatchObject({
      running: false,
      fills: 2,
      endReason: "stopped: from the dashboard",
    });
    expect(past!.volume).toBeCloseTo(20.005);
    // +0.005 realised − 0.02 fees.
    expect(past!.realisedNet).toBeCloseTo(-0.015);
    expect(past!.makerShare).toBe(1);
  });

  it("closes a run whose process died at its last fill", () => {
    const { store, bot } = setup();
    store.startSession(bot.id, NOW - 30 * MIN);
    store.addFill(bot.id, fill(1, "BUY", "10000", 25));
    const [s] = sessionViews(store, [bot], {
      now: NOW,
      mark: () => undefined,
      online: () => false,
    });
    expect(s).toMatchObject({
      running: false,
      endReason: "process ended",
      endedAt: NOW - 25 * MIN,
    });
  });
});

describe("periods", () => {
  it("splits volume and PnL by period and adds the open position's PnL", () => {
    const fills = [
      fill(1, "BUY", "10000", 9 * 24 * 60), // older than 7 days
      fill(2, "SELL", "10010", 9 * 24 * 60 - 1),
      fill(3, "BUY", "10000", 30), // this session
      fill(4, "SELL", "10005", 20),
      fill(5, "BUY", "10000", 10), // still open
    ];
    const p = periods(fills, 0.002, {
      session: NOW - 40 * MIN,
      week: NOW - 7 * 24 * 60 * MIN,
      all: 0,
    });
    expect(p.all.fills).toBe(5);
    expect(p.week.fills).toBe(3);
    expect(p.session.volume).toBeCloseTo(30.005);
    // Session: +0.005 realised − 3 × 0.01 fees + 0.002 open.
    expect(p.session.pnl).toBeCloseTo(-0.023);
    expect(p.session.costPerMillion).toBeCloseTo((0.023 / 30.005) * 1_000_000);
    expect(p.all.makerShare).toBe(1);
  });
});
