import { SqliteStore, type BotRecord } from "@sodextra/engine-core";
import { describe, expect, it } from "vitest";

import { profitView } from "../src/profit.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function setup() {
  const store = new SqliteStore(":memory:");
  const bot: BotRecord = {
    id: "g1",
    name: "grid-btc",
    strategy: "grid",
    symbol: "BTC-USD",
    market: "perps",
    mode: "live",
    config: { lower: 76000, upper: 78000, grids: 10, investment: 80, leverage: 2 },
    status: "running",
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW,
  };
  store.createBot(bot);
  return { store, bot };
}

describe("PnL samples", () => {
  it("keeps one sample an hour once they're old", () => {
    const { store, bot } = setup();
    for (let t = NOW - 3 * HOUR; t < NOW; t += MIN) store.addSample(bot.id, t, 1);
    store.thinSamples(bot.id, NOW - HOUR);
    const left = store.listSamples(bot.id, 0);
    expect(left.filter((s) => s.at < NOW - HOUR).map((s) => s.at)).toEqual([
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
    ]);
    expect(left.filter((s) => s.at >= NOW - HOUR)).toHaveLength(60);
  });

  it("are deleted with the bot", () => {
    const { store, bot } = setup();
    store.addSample(bot.id, NOW, 1, { gridProfit: 0.5 });
    store.deleteBot(bot.id);
    expect(store.listSamples(bot.id, 0)).toEqual([]);
  });
});

describe("profitView", () => {
  it("counts this run's profit from zero, from the run's first sample", () => {
    const { store, bot } = setup();
    store.addSample(bot.id, NOW - 5 * HOUR, 0.4, { gridProfit: 0.3, roundTrips: 3 }); // an older run
    const run = store.startSession(bot.id, NOW - 30 * MIN);
    expect(run).toBeGreaterThan(0);
    store.addSample(bot.id, NOW - 30 * MIN, 0.5, { gridProfit: 0.3, roundTrips: 3 });
    store.addSample(bot.id, NOW - 10 * MIN, 0.62, { gridProfit: 0.4, roundTrips: 4 });
    const v = profitView(store, bot, "run", NOW);
    expect(v.from).toBe(NOW - 30 * MIN);
    expect(v.points.map((p) => p.at)).toEqual([NOW - 30 * MIN, NOW - 10 * MIN]);
    expect(v.points[0]).toMatchObject({ pnl: 0, gridProfit: 0, roundTrips: 0 });
    expect(v.points[1]!.pnl).toBeCloseTo(0.12);
    expect(v.points[1]!.gridProfit).toBeCloseTo(0.1);
    expect(v.points[1]!.roundTrips).toBe(1);
  });

  it("shows the bot's totals for all time, thinned to a chart's worth of points", () => {
    const { store, bot } = setup();
    for (let t = NOW - 10 * HOUR; t < NOW; t += MIN)
      store.addSample(bot.id, t, (t - (NOW - 10 * HOUR)) / HOUR, { gridProfit: 1 });
    const v = profitView(store, bot, "all", NOW);
    expect(v.points.length).toBeLessThanOrEqual(241);
    expect(v.points[0]).toMatchObject({ at: NOW - 10 * HOUR, pnl: 0, gridProfit: 1 });
    expect(v.points.at(-1)!.at).toBe(NOW - MIN); // the latest sample is always kept
    expect(v.points.at(-1)!.pnl).toBeCloseTo(10 - 1 / 60);
  });

  it("has no points before the bot's first sample", () => {
    const { store, bot } = setup();
    expect(profitView(store, bot, "day", NOW).points).toEqual([]);
  });
});
