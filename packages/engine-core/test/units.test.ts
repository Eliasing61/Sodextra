import { describe, expect, it } from "vitest";

import {
  applyFill,
  candlePath,
  correctFeeCoin,
  clOrdId,
  diffOrders,
  emptyPosition,
  SimCore,
  SqliteStore,
  totalPnl,
  type AccountEvent,
  type TrackedOrder,
} from "../src/index.ts";
import { BTC, limit } from "./helpers.ts";

const fill = (side: "BUY" | "SELL", price: string, quantity: string, fee = "0") => ({
  side,
  price,
  quantity,
  fee,
});

describe("position accounting", () => {
  it("averages entries, realises PnL on reduction and flips cleanly", () => {
    let p = emptyPosition();
    p = applyFill(p, fill("BUY", "100", "1", "0.01"));
    p = applyFill(p, fill("BUY", "110", "1", "0.01"));
    expect(p.size).toBe("2");
    expect(p.avgEntry).toBe("105");

    p = applyFill(p, fill("SELL", "120", "1"));
    expect(p.realizedPnl).toBe("15");
    expect(p.size).toBe("1");

    p = applyFill(p, fill("SELL", "90", "3")); // close 1 at a loss, open 2 short
    expect(p.realizedPnl).toBe("0");
    expect(p.size).toBe("-2");
    expect(p.avgEntry).toBe("90");
    expect(totalPnl(p, "80")).toBe("19.98"); // 0 realised + 20 unrealised − 0.02 fees
  });

  it("treats spot fees charged in the base coin as quote cost and less base received", () => {
    const p = applyFill(
      emptyPosition(),
      { side: "BUY", price: "2000", quantity: "1", fee: "0.001", feeCoin: "vETH" },
      "vETH",
    );
    expect(p.size).toBe("0.999");
    expect(p.fees).toBe("2");
  });

  it("counts a spot buy's fee in the coin before the fill names the coin", () => {
    // The WebSocket copy has no fee coin. A 0.001 ETH fee is $2, not $0.001 (a PEPE fee
    // of 857 coins once counted as $857 and tripped the loss limit).
    const ws = { side: "BUY" as const, price: "2000", quantity: "1", fee: "0.001" };
    const seen = applyFill(emptyPosition(), ws, "vETH");
    expect(seen.size).toBe("0.999");
    expect(seen.fees).toBe("2");
    // The REST copy agrees: nothing to move. Had it named USDC, the fee moves back.
    expect(correctFeeCoin(seen, ws, { ...ws, feeCoin: "vETH" }, "vETH")).toBe(seen);
    const usdc = correctFeeCoin(seen, ws, { ...ws, feeCoin: "vUSDC" }, "vETH");
    expect(usdc.size).toBe("1");
    expect(usdc.fees).toBe("0.001");
    // A spot sell pays in USDC; perps (no base coin) always in USDC.
    const sold = applyFill(
      seen,
      { side: "SELL", price: "2100", quantity: "0.5", fee: "0.37" },
      "vETH",
    );
    expect(sold.fees).toBe("2.37");
    expect(applyFill(emptyPosition(), ws).fees).toBe("0.001");
  });
});

describe("order diff", () => {
  const order = (key: string, status: TrackedOrder["status"], price = "100"): TrackedOrder => ({
    clOrdID: `c-${key}`,
    key,
    side: "BUY",
    kind: "limit",
    price,
    quantity: "1",
    filledQty: "0",
    postOnly: true,
    reduceOnly: false,
    status,
    createdAt: 0,
    updatedAt: 0,
  });

  it("keeps matches (decimal-equal), cancels changes and strays, places new keys", () => {
    const d = diffOrders(
      [
        limit("keep", "BUY", "100.0", "1"),
        limit("move", "BUY", "99", "1"),
        limit("new", "BUY", "98", "1"),
      ],
      [order("keep", "open"), order("move", "open"), order("stray", "partially_filled")],
    );
    expect(d.place.map((o) => o.key)).toEqual(["new"]);
    expect(d.cancel.map((o) => o.key).sort()).toEqual(["move", "stray"]);
    expect(d.waiting).toEqual(["move"]);
  });

  it("never sends anything for a key with an unresolved request", () => {
    const d = diffOrders(
      [limit("a", "BUY", "99", "1")],
      [order("a", "pending"), order("b", "unknown")],
    );
    expect(d).toEqual({ cancel: [], place: [], replace: [], waiting: ["a", "b"] });
  });

  it("rejects duplicate keys from a strategy", () => {
    expect(() =>
      diffOrders([limit("a", "BUY", "1", "1"), limit("a", "SELL", "2", "1")], []),
    ).toThrow(/duplicate/);
  });
});

describe("simulated exchange", () => {
  function core() {
    const events: AccountEvent[] = [];
    const sim = new SimCore({
      symbol: BTC,
      market: "perps",
      makerFee: "0.0001",
      takerFee: "0.0005",
      quoteBalance: "1000",
      now: () => 0,
      emit: (e) => events.push(e),
    });
    sim.setBook("99", "101");
    sim.setMark("100");
    return { sim, events };
  }

  it("fills resting limits only when the market trades through them", () => {
    const { sim, events } = core();
    sim.place([
      {
        clOrdID: "b",
        side: "BUY",
        kind: "limit",
        price: "95",
        quantity: "1",
        timeInForce: "GTX",
        reduceOnly: false,
      },
    ]);
    sim.onTrade("95");
    expect(sim.snapshot().position.size).toBe("0");
    sim.onTrade("94.9");
    expect(sim.snapshot().position.size).toBe("1");
    const f = events.find((e) => e.type === "fill");
    expect(f?.type === "fill" && f.fill.fee).toBe("0.0095"); // maker
  });

  it("expires crossing post-only orders and fills crossing GTC orders as taker", () => {
    const { sim, events } = core();
    sim.place([
      {
        clOrdID: "x",
        side: "BUY",
        kind: "limit",
        price: "102",
        quantity: "1",
        timeInForce: "GTX",
        reduceOnly: false,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "order", status: "expired" });
    sim.place([
      {
        clOrdID: "y",
        side: "BUY",
        kind: "limit",
        price: "102",
        quantity: "1",
        timeInForce: "GTC",
        reduceOnly: false,
      },
    ]);
    expect(sim.state.fills.at(-1)).toMatchObject({ price: "101", isMaker: false });
  });

  it("triggers a full-position stop-loss on the mark price", () => {
    const { sim } = core();
    sim.place([
      {
        clOrdID: "m",
        side: "BUY",
        kind: "market",
        quantity: "2",
        timeInForce: "IOC",
        reduceOnly: false,
      },
    ]);
    sim.place([
      {
        clOrdID: "sl",
        side: "SELL",
        kind: "stop",
        stopPrice: "90",
        stopType: "STOP_LOSS",
        timeInForce: "IOC",
        reduceOnly: true,
      },
    ]);
    sim.setBook("89", "91");
    sim.setMark("91");
    expect(sim.snapshot().position.size).toBe("2");
    sim.setMark("90");
    expect(sim.snapshot().position.size).toBe("0");
  });

  it("walks bullish candles low-first and bearish candles high-first", () => {
    expect(candlePath({ o: "100", h: "110", l: "95", c: "105" })).toEqual([
      "100",
      "95",
      "110",
      "105",
    ]);
    expect(candlePath({ o: "100", h: "110", l: "95", c: "97" })).toEqual([
      "100",
      "110",
      "95",
      "97",
    ]);
  });
});

describe("SqliteStore", () => {
  it("de-duplicates fills and separates active from closed orders", () => {
    const store = new SqliteStore(":memory:");
    store.createBot({
      id: "b1",
      name: "n",
      strategy: "s",
      symbol: "BTC-USD",
      market: "perps",
      mode: "paper",
      config: {},
      status: "created",
      createdAt: 0,
      updatedAt: 0,
    });
    const f = {
      tradeId: "1",
      clOrdID: "c1",
      side: "BUY" as const,
      price: "1",
      quantity: "1",
      fee: "0",
      time: 5,
    };
    expect(store.addFill("b1", f)).toBe(true);
    expect(store.addFill("b1", f)).toBe(false);
    expect(store.lastFillTime("b1")).toBe(5);

    const base = {
      key: "k",
      side: "BUY" as const,
      kind: "limit" as const,
      filledQty: "0",
      postOnly: true,
      reduceOnly: false,
      createdAt: 0,
      updatedAt: 0,
    };
    store.saveOrder("b1", { ...base, clOrdID: "c1", status: "open" });
    store.saveOrder("b1", { ...base, clOrdID: "c2", status: "filled" });
    expect(store.activeOrders("b1").map((o) => o.clOrdID)).toEqual(["c1"]);

    store.setKV("b1", "engine", { seq: 3 });
    expect(store.getKV<{ seq: number }>("b1", "engine")?.seq).toBe(3);
    expect(() => store.createBot({ ...store.getBot("b1")!, id: "b2" })).toThrow(); // (name, mode) is unique
  });
});

describe("clOrdId", () => {
  it("encodes prefix, bot and sequence within 36 characters", () => {
    expect(clOrdId("g", "k3f9x0aa", 1295)).toBe("sxg-k3f9x0aa-zz");
    expect(clOrdId("g", "k3f9x0aa", Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(36);
  });
});

describe("zero is neither long nor short", () => {
  it("rejects a reduce-only sell when flat instead of filling nothing", () => {
    const events: AccountEvent[] = [];
    const sim = new SimCore({
      symbol: BTC,
      market: "perps",
      makerFee: "0",
      takerFee: "0",
      quoteBalance: "1000",
      now: () => 0,
      emit: (e) => events.push(e),
    });
    sim.setBook("99", "101");
    const [r] = sim.place([
      {
        clOrdID: "r",
        side: "SELL",
        kind: "market",
        quantity: "1",
        timeInForce: "IOC",
        reduceOnly: true,
      },
    ]);
    expect(r?.ok).toBe(false);
    expect(sim.state.fills).toHaveLength(0);
  });
});

describe("diff with replace", () => {
  const live = (over: Partial<TrackedOrder> = {}): TrackedOrder => ({
    clOrdID: "c1",
    key: "Q",
    side: "BUY",
    kind: "limit",
    price: "100",
    quantity: "1",
    filledQty: "0",
    postOnly: true,
    reduceOnly: false,
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it("replaces an unfilled order whose price changed", () => {
    const d = diffOrders([limit("Q", "BUY", "99", "1")], [live()], { canReplace: true });
    expect(d.replace).toHaveLength(1);
    expect(d.cancel).toEqual([]);
  });

  it("cancels instead when the order is partly filled or changes side", () => {
    expect(
      diffOrders(
        [limit("Q", "BUY", "99", "1")],
        [live({ filledQty: "0.5", status: "partially_filled" })],
        { canReplace: true },
      ).cancel,
    ).toHaveLength(1);
    expect(
      diffOrders([limit("Q", "SELL", "101", "1")], [live()], { canReplace: true }).cancel,
    ).toHaveLength(1);
  });
});

describe("paper queue model", () => {
  function sim() {
    const events: AccountEvent[] = [];
    const s = new SimCore({
      symbol: BTC,
      market: "perps",
      makerFee: "0",
      takerFee: "0",
      quoteBalance: "1000",
      now: () => 0,
      emit: (e) => events.push(e),
      queueModel: true,
    });
    s.setBook("100", "101", "0.5", "0.4");
    return { s, events };
  }
  const bid = {
    clOrdID: "b",
    side: "BUY" as const,
    kind: "limit" as const,
    price: "100",
    quantity: "0.2",
    timeInForce: "GTX" as const,
    reduceOnly: false,
  };

  it("fills a quote at the best bid only after the queue ahead has traded", () => {
    const { s } = sim();
    s.place([bid]); // 0.5 already resting ahead
    s.onTrade("100", "0.3", "SELL");
    expect(s.state.fills).toHaveLength(0);
    s.onTrade("100", "0.3", "SELL"); // 0.1 past the queue → partial fill
    expect(s.state.fills.at(-1)?.quantity).toBe("0.1");
    expect(s.findOrder("b")?.status).toBe("partially_filled");
    s.onTrade("100", "0.5", "SELL");
    expect(s.findOrder("b")).toBeUndefined(); // fully filled
    expect(s.snapshot().position.size).toBe("0.2");
  });

  it("ignores trades on the other side and fills fully on a trade through", () => {
    const { s } = sim();
    s.place([bid]);
    s.onTrade("100", "5", "BUY"); // buyers lifting asks don't touch bids
    expect(s.state.fills).toHaveLength(0);
    s.onTrade("99", "0.01", "SELL");
    expect(s.snapshot().position.size).toBe("0.2");
  });

  it("puts a quote inside the spread at the front of the queue", () => {
    const { s } = sim();
    s.setBook("100", "102", "0.5", "0.4");
    s.place([{ ...bid, price: "101" }]);
    s.onTrade("101", "0.05", "SELL");
    expect(s.state.fills.at(-1)?.quantity).toBe("0.05");
  });

  it("replaces atomically and loses queue position", () => {
    const { s, events } = sim();
    s.place([bid]);
    const [r] = s.replace([{ origClOrdID: "b", clOrdID: "b2", price: "99" }]);
    expect(r?.ok).toBe(true);
    expect(s.findOrder("b")).toBeUndefined();
    expect(s.findOrder("b2")?.price).toBe("99");
    expect(
      events.some((e) => e.type === "order" && e.clOrdID === "b" && e.status === "canceled"),
    ).toBe(true);
  });
});
