import { SqliteStore, type BotRecord, type Fill } from "@sodextra/engine-core";
import { describe, expect, it } from "vitest";

import { fillHistory, fillRows, spotBase } from "../src/fill-history.ts";

const T = Date.UTC(2026, 10, 2, 12, 0, 0);

const fill = (i: number, side: "BUY" | "SELL", price: string, time: number): Fill => ({
  tradeId: `t${i}`,
  clOrdID: `sxm-b-${i}`,
  side,
  price,
  quantity: "0.001",
  fee: "0.01",
  isMaker: true,
  time,
});

function setup(id: string) {
  const store = new SqliteStore(":memory:");
  const bot: BotRecord = {
    id,
    name: id,
    strategy: "maker",
    symbol: "BTC-USD",
    market: "perps",
    mode: "live",
    status: "running",
    config: {},
    createdAt: T,
    updatedAt: T,
  };
  store.createBot(bot);
  return store;
}

describe("fill history cache", () => {
  it("adds only new fills (also ones in the same millisecond) and matches a full replay", () => {
    const store = setup("h1");
    store.addFill("h1", fill(1, "BUY", "100", T));
    store.addFill("h1", fill(2, "SELL", "101", T + 1_000));
    const first = fillHistory(store, "h1");
    expect(first.fills.map((f) => f.tradeId)).toEqual(["t1", "t2"]);

    store.addFill("h1", fill(3, "BUY", "99", T + 1_000)); // same ms as t2
    store.addFill("h1", fill(4, "SELL", "102", T + 2_000));
    const next = fillHistory(store, "h1");
    expect(next.fills.map((f) => f.tradeId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(next.rows).toEqual(fillRows(store.listFills("h1").reverse()));
  });

  it("rebuilds when a fill arrives with an older time", () => {
    const store = setup("h2");
    store.addFill("h2", fill(1, "BUY", "100", T + 5_000));
    fillHistory(store, "h2");
    store.addFill("h2", fill(2, "SELL", "101", T)); // older than the newest
    const h = fillHistory(store, "h2");
    expect(h.fills.map((f) => f.tradeId)).toEqual(["t2", "t1"]);
    expect(h.rows).toEqual(fillRows(store.listFills("h2").reverse()));
  });

  it("counts a spot buy's fee, paid in the coin, at its USDC value", () => {
    expect(spotBase({ market: "spot", symbol: "vPEPE_vUSDC" })).toBe("vPEPE");
    expect(spotBase({ market: "perps", symbol: "BTC-USD" })).toBeUndefined();
    // $12 of PEPE: an 857-coin fee is $0.0042, not $857.
    const buy: Fill = { ...fill(1, "BUY", "0.0000049", T), quantity: "2448979", fee: "857.14" };
    const sell: Fill = {
      ...fill(2, "SELL", "0.000005", T + 1),
      quantity: "2448000",
      fee: "0.0043",
    };
    const rows = fillRows([buy, sell], "vPEPE");
    expect(rows[0]!.fee).toBeCloseTo(0.0042, 4);
    expect(rows[1]!.fee).toBeCloseTo(0.0043, 6);
    expect(rows[1]!.realised).toBeGreaterThan(0);
  });

  it("starts over for a deleted bot", () => {
    const store = setup("h3");
    store.addFill("h3", fill(1, "BUY", "100", T));
    expect(fillHistory(store, "h3").fills).toHaveLength(1);
    store.deleteBot("h3");
    expect(fillHistory(store, "h3").fills).toHaveLength(0);
  });
});
