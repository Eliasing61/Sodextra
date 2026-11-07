import { describe, expect, it } from "vitest";

import type { SpotSymbol } from "@sodextra/sodex-client";

import { BacktestExchange, SqliteStore } from "../src/index.ts";
import { BTC, limit, scripted, setup } from "./helpers.ts";

describe("BotEngine", () => {
  it("places what the strategy wants as post-only orders and tracks them", async () => {
    const { engine, exchange, store, control, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002"), limit("L2", "SELL", "78000", "0.0002")];
    await engine.start();

    const active = store.activeOrders(bot.id);
    expect(active.map((o) => [o.key, o.status, o.postOnly])).toEqual([
      ["L1", "open", true],
      ["L2", "open", true],
    ]);
    expect(active[0]!.clOrdID).toMatch(/^sxt-testbot1-[0-9a-z]+$/);
    expect((await exchange.snapshot()).openOrders).toHaveLength(2);
  });

  it("applies fills once, updates the position and tells the strategy", async () => {
    const { engine, exchange, store, control, calls, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();

    control.want = [];
    exchange.tick(1_060_000, "75990"); // trades through 76000
    await engine.cycle();
    await engine.reconcile(); // re-delivers the same fill via fillsSince: must be ignored

    expect(calls.fills).toHaveLength(1);
    expect(engine.summary().position.size).toBe("0.0002");
    expect(engine.summary().position.avgEntry).toBe("76000");
    expect(store.listFills(bot.id)).toHaveLength(1);
    expect(store.activeOrders(bot.id)).toHaveLength(0);
  });

  it("re-prices atomically with replace in one cycle", async () => {
    const { engine, exchange, store, control, calls, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    const before = engine.summary().stats.actions;

    control.want = [limit("L1", "BUY", "75500", "0.0002")];
    await engine.cycle();
    const [order] = store.activeOrders(bot.id);
    expect(order?.price).toBe("75500");
    expect(order?.status).toBe("open");
    expect((await exchange.snapshot()).openOrders.map((o) => o.price)).toEqual(["75500"]);
    expect(engine.summary().stats.actions - before).toBe(1); // one action, not cancel + place
    expect(calls.closed).toEqual([]); // a replace is not a close
  });

  it("does not count a replace that raced a fill (OrderNotFound) as a reject", async () => {
    const run = async (error: string) => {
      const { engine, exchange, control } = setup();
      exchange.tick(1_000_000, "77000");
      control.want = [limit("L1", "BUY", "76000", "0.0002")];
      await engine.start();
      Object.defineProperty(exchange, "replace", {
        value: async (requests: { clOrdID: string }[]) =>
          requests.map((r) => ({ clOrdID: r.clOrdID, ok: false, error })),
      });
      for (let i = 0; i < 6; i++) {
        control.want = [limit("L1", "BUY", i % 2 ? "75500" : "75400", "0.0002")];
        await engine.cycle();
      }
      return engine.status;
    };
    expect(await run("order rejected: OrderNotFound")).toBe("running");
    expect(await run("order rejected: PriceOutOfBand")).toBe("paused");
  });

  it("quotes again after a quote vanished and every move of it comes back OrderNotFound", async () => {
    const { engine, exchange, store, control, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    const [lost] = store.activeOrders(bot.id);
    // SoDEX drops the quote without telling the bot (no order event arrives).
    await exchange.cancel([lost!.clOrdID]);
    let replaces = 0;
    Object.defineProperty(exchange, "replace", {
      value: async (requests: { clOrdID: string }[]) => {
        replaces += 1;
        return requests.map((r) => ({
          clOrdID: r.clOrdID,
          ok: false,
          error: "order rejected: OrderNotFound",
        }));
      },
    });
    // The strategy keeps asking to move it, once a second, for a minute.
    for (let i = 0; i < 60; i++) {
      exchange.tick(1_001_000 + i * 1_000, "77000");
      control.want = [limit("L1", "BUY", i % 2 ? "75500" : "75400", "0.0002")];
      await engine.cycle();
    }
    expect(replaces).toBe(1); // tried once, then waited for the check
    const open = (await exchange.snapshot()).openOrders;
    expect(open).toHaveLength(1); // a fresh quote is back on the book
    expect(open[0]!.clOrdID).not.toBe(lost!.clOrdID);
  });

  it("falls back to cancel first, place next cycle, when the exchange can't replace", async () => {
    const { engine, exchange, store, control, calls, bot } = setup();
    Object.defineProperty(exchange, "replace", { value: undefined });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();

    control.want = [limit("L1", "BUY", "75500", "0.0002")];
    await engine.cycle();
    expect(calls.closed.map((o) => o.status)).toEqual(["canceled"]);
    expect(store.activeOrders(bot.id)).toHaveLength(0);

    await engine.cycle();
    const [order] = store.activeOrders(bot.id);
    expect(order?.price).toBe("75500");
    expect((await exchange.snapshot()).openOrders.map((o) => o.price)).toEqual(["75500"]);
  });

  it("re-sends a crossing post-only order as a taker when asked to", async () => {
    const { engine, exchange, control } = setup();
    exchange.tick(1_000_000, "77000"); // ask 77001
    control.want = [limit("L1", "BUY", "77100", "0.0002", { onPostOnlyReject: "taker" })];
    await engine.start(); // GTX expires
    await engine.cycle(); // learns about the expiry
    expect(engine.summary().position.size).toBe("0");

    await engine.cycle(); // re-sent as GTC → fills at the ask as taker
    await engine.cycle();
    expect(engine.summary().position.size).toBe("0.0002");
    expect(engine.summary().position.avgEntry).toBe("77001");
  });

  it("sends a one-shot order once, even while it's still asked for after it filled", async () => {
    const { engine, exchange, store, control, calls, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("T1", "BUY", "77100", "0.0002", { ioc: true, once: true })];
    await engine.start();
    const actions = engine.summary().stats.actions;
    expect(actions).toBe(1);

    // The strategy hasn't moved on yet: the filled order must not be sent again.
    await engine.cycle();
    await engine.cycle();
    expect(calls.fills).toHaveLength(1);
    expect(engine.summary().stats.actions).toBe(actions);
    expect(engine.summary().position.size).toBe("0.0002");

    // A new key is a new order.
    control.want = [limit("T2", "SELL", "76900", "0.0002", { ioc: true, once: true })];
    await engine.cycle();
    await engine.cycle();
    expect(calls.fills).toHaveLength(2);
    expect(engine.summary().position.size).toBe("0");
    expect(store.activeOrders(bot.id)).toHaveLength(0);
  });

  it("tells the strategy how many of the account's other orders rest on the market", async () => {
    const s = scripted();
    let seen: number | undefined;
    s.strategy.desired = (ctx) => {
      seen = ctx.otherOrders?.();
      return s.control.want;
    };
    const { engine, exchange } = setup({ scripted: s });
    exchange.tick(1_000_000, "77000");
    await engine.start();
    expect(seen).toBe(0);

    // A resting order the bot didn't place (another bot's, or one placed by hand).
    await exchange.place([
      {
        clOrdID: "manual-1",
        side: "BUY",
        kind: "limit",
        price: "70000",
        quantity: "0.0002",
        timeInForce: "GTC",
        reduceOnly: false,
      },
    ]);
    await engine.reconcile();
    await engine.cycle();
    expect(seen).toBe(1);
  });

  it("skips orders that would exceed the notional cap or break exchange filters", async () => {
    const { engine, exchange, store, control, events, bot } = setup({
      risk: { maxNotional: "20" },
    });
    exchange.tick(1_000_000, "77000");
    control.want = [
      limit("A", "BUY", "76000", "0.0002"), // 15.2 → fits
      limit("B", "BUY", "75000", "0.0002"), // would bring exposure to 30.2 → skipped
      limit("C", "BUY", "76000.5", "0.0002"), // not on the tick grid → skipped
    ];
    await engine.start();
    expect(store.activeOrders(bot.id).map((o) => o.key)).toEqual(["A"]);
    expect(events.map((e) => e.message).join("\n")).toMatch(/risk.maxNotional/);
    expect(events.map((e) => e.message).join("\n")).toMatch(/tickSize/);
  });

  it("holds new orders when market data is stale", async () => {
    const { engine, exchange, store, control, events, bot } = setup({
      risk: { staleDataMs: 10_000 },
    });
    exchange.tick(1_000_000, "77000");
    await engine.start();
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    // 20 s pass on the clock without any market event reaching the engine.
    Object.defineProperty(exchange, "now", { value: () => 1_020_000 });
    await engine.cycle();
    expect(store.activeOrders(bot.id)).toHaveLength(0);
    expect(events.some((e) => /No market data/.test(e.message))).toBe(true);
  });

  it("pulls quotes when prices stop, reconnects the feed, and quotes again when they're back", async () => {
    const s = scripted();
    const { engine, exchange, store, control, events, bot } = setup({
      scripted: { ...s, strategy: { ...s.strategy, quoting: true } },
      risk: { staleDataMs: 3_000, stalePullMs: 5_000, staleReconnectMs: 10_000 },
    });
    let reconnects = 0;
    Object.defineProperty(exchange, "reconnect", { value: () => (reconnects += 1) });
    const clock = (t: number) =>
      Object.defineProperty(exchange, "now", { value: () => t, configurable: true });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    expect(store.activeOrders(bot.id)).toHaveLength(1);

    clock(1_006_000); // 6 s without prices: quotes come off
    await engine.cycle();
    expect(store.activeOrders(bot.id)).toHaveLength(0);
    expect(events.some((e) => /quotes pulled/.test(e.message))).toBe(true);
    expect(reconnects).toBe(0);

    clock(1_012_000); // 12 s: reconnect the feed, once
    await engine.cycle();
    await engine.cycle();
    expect(reconnects).toBe(1);

    delete (exchange as { now?: unknown }).now;
    exchange.tick(1_013_000, "77000"); // prices are back
    await engine.cycle();
    expect(events.some((e) => /Price feed is back/.test(e.message))).toBe(true);
    expect(store.activeOrders(bot.id)).toHaveLength(1);
  });

  it("checks with the exchange soon after an order's outcome is unknown", async () => {
    const { engine, exchange, store, control, bot } = setup({ risk: { unknownRecheckMs: 2_000 } });
    exchange.tick(1_000_000, "77000");
    await engine.start();
    const place = exchange.place.bind(exchange);
    let lost = true;
    exchange.place = async (requests) => {
      const results = await place(requests); // the order does reach the book…
      if (!lost) return results;
      lost = false;
      return results.map((r) => ({ clOrdID: r.clOrdID, ok: false, unknown: true }));
    };
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.cycle();
    expect(store.activeOrders(bot.id)[0]!.status).toBe("unknown"); // …but the answer is lost

    exchange.tick(1_003_000, "77000");
    await engine.cycle(); // no 30 s wait for the regular check
    expect(store.activeOrders(bot.id)[0]!.status).toBe("open");
  });

  it("pauses after too many rejections in a row", async () => {
    const { engine, exchange, control } = setup({ risk: { maxConsecutiveRejects: 3 } });
    exchange.tick(1_000_000, "77000");
    // Reduce-only buys with no short position are rejected by the simulator.
    control.want = [1, 2, 3].map((i) =>
      limit(`R${i}`, "BUY", "77100", "0.0002", { reduceOnly: true, postOnly: false }),
    );
    await engine.start();
    await engine.cycle();
    expect(engine.status).toBe("paused");
    expect(engine.summary().statusReason).toMatch(/rejected in a row/);
  });

  it("recovers after a restart: catches fills that happened while it was down", async () => {
    const store = new SqliteStore(":memory:");
    const exchange = new BacktestExchange({
      market: "perps",
      symbol: BTC,
      makerFee: "0.00012",
      takerFee: "0.0004",
      quoteBalance: "1000",
      startTime: 1_000_000,
    });
    const first = setup({ store, exchange });
    exchange.tick(1_000_000, "77000");
    first.control.want = [
      limit("L1", "BUY", "76000", "0.0002"),
      limit("L2", "BUY", "75000", "0.0002"),
    ];
    await first.engine.start();
    await first.engine.detach();

    // While "offline": price trades through L1 only, then recovers.
    exchange.tick(1_100_000, "75990");
    exchange.tick(1_150_000, "77000");

    const second = scripted();
    second.control.want = first.control.want;
    const again = setup({
      store,
      exchange,
      scripted: second,
      bot: store.getBot("testbot1")!,
    });
    await again.engine.start();

    expect(second.calls.fills.map((f) => f.price)).toEqual(["76000"]);
    expect(again.engine.summary().position.size).toBe("0.0002");
    // L1 is filled; it is wanted again so it gets re-placed. L2 keeps its original order.
    const keys = store
      .activeOrders("testbot1")
      .map((o) => o.key)
      .sort();
    expect(keys).toEqual(["L1", "L2"]);
    expect((await exchange.snapshot()).openOrders).toHaveLength(2);
  });

  it("cancels orphaned orders carrying this bot's prefix", async () => {
    const { engine, exchange, events } = setup();
    exchange.tick(1_000_000, "77000");
    await engine.start();
    exchange.core.place([
      {
        clOrdID: "sxt-testbot1-zz",
        side: "BUY",
        kind: "limit",
        price: "70000",
        quantity: "0.0002",
        timeInForce: "GTC",
        reduceOnly: false,
      },
    ]);
    exchange.core.place([
      {
        clOrdID: "someone-else",
        side: "BUY",
        kind: "limit",
        price: "70000",
        quantity: "0.0002",
        timeInForce: "GTC",
        reduceOnly: false,
      },
    ]);
    await engine.reconcile();
    const left = (await exchange.snapshot()).openOrders.map((o) => o.clOrdID);
    expect(left).toEqual(["someone-else"]);
    expect(events.some((e) => e.type === "orphans")).toBe(true);
  });

  it("pauses on position drift that lasts, and carries on once the exchange agrees again", async () => {
    const { engine, exchange, events } = setup();
    exchange.tick(1_000_000, "77000");
    await engine.start();
    const manual = (id: string, side: "BUY" | "SELL") =>
      exchange.core.place([
        {
          clOrdID: id,
          side,
          kind: "market",
          quantity: "0.001",
          timeInForce: "IOC",
          reduceOnly: false,
        },
      ]);
    // A trade on the same symbol, not made by the bot.
    manual("manual-1", "BUY");
    await engine.reconcile();
    expect(engine.status).toBe("running");
    // Seen again 10 s later: SoDEX's account data can run that late when it's busy.
    exchange.tick(1_010_000, "77000");
    await engine.reconcile();
    expect(engine.status).toBe("running");
    // Still there 31 s after it was first seen: pause.
    exchange.tick(1_031_000, "77000");
    await engine.reconcile();
    expect(engine.status).toBe("paused");
    expect(engine.summary().statusReason).toMatch(/drift/);

    // The account matches the bot again: it trades again by itself.
    manual("manual-2", "SELL");
    exchange.tick(1_061_000, "77000");
    await engine.reconcile();
    expect(engine.status).toBe("running");
    expect(events.some((e) => e.type === "drift-cleared")).toBe(true);
  });

  it("does not lift a pause it didn't make when positions agree", async () => {
    const { engine, exchange } = setup();
    exchange.tick(1_000_000, "77000");
    await engine.start();
    engine.pause("paused by hand");
    exchange.tick(1_030_000, "77000");
    await engine.reconcile();
    expect(engine.status).toBe("paused");
  });

  it("does not pause for a fill that is in flight (pushed but not yet in trade history)", async () => {
    const { engine, exchange, control, store, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    // Trade history lags: the REST fill query doesn't have the fill yet.
    Object.defineProperty(exchange, "fillsSince", { value: async () => [] });
    exchange.tick(1_060_000, "75990"); // fills L1; the fill event waits in the queue
    await engine.reconcile();
    await engine.reconcile();
    expect(engine.status).toBe("running");
    expect(engine.summary().position.size).toBe("0.0002");
    expect(store.listFills(bot.id)).toHaveLength(1);
    await engine.cycle(); // the queued fill is now a duplicate and is ignored
    expect(store.listFills(bot.id)).toHaveLength(1);
  });

  it("stops: cancels everything and closes the position", async () => {
    const { engine, exchange, store, control, bot } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002"), limit("L2", "BUY", "75000", "0.0002")];
    await engine.start();
    exchange.tick(1_060_000, "75990");
    await engine.cycle();
    expect(engine.summary().position.size).toBe("0.0002");

    await engine.stop({ closePosition: true });
    await engine.cycle();
    expect(engine.status).toBe("stopped");
    expect((await exchange.snapshot()).openOrders).toHaveLength(0);
    expect((await exchange.snapshot()).position.size).toBe("0");
    expect(engine.summary().position.size).toBe("0");
    expect(store.getBot(bot.id)?.status).toBe("stopped");
  });
});

describe("spot", () => {
  /** A $100 coin: 0.01 lots, $5 smallest order. */
  const COIN: SpotSymbol = {
    ...BTC,
    id: 7,
    name: "vCOIN_vUSDC",
    displayName: "COIN/USDC",
    baseCoinID: 9,
    baseCoin: "vCOIN",
    tickSize: "0.01",
    minPrice: "0.01",
    stepSize: "0.01",
    minQuantity: "0.01",
    marketMinQuantity: "0.01",
    minNotional: "5",
  };
  function spotSetup() {
    const exchange = new BacktestExchange({
      market: "spot",
      symbol: COIN,
      makerFee: "0.00035",
      takerFee: "0.00065",
      quoteBalance: "1000",
      startTime: 1_000_000,
    });
    const bot = {
      id: "spotbot1",
      name: "spot",
      strategy: "scripted",
      symbol: COIN.name,
      market: "spot" as const,
      mode: "backtest" as const,
      config: {},
      status: "created" as const,
      createdAt: 0,
      updatedAt: 0,
    };
    return setup({ exchange, bot });
  }

  it("counts the buy's fee in the coin and sells whole lots at stop, leaving the rest", async () => {
    const { engine, exchange, control, events } = spotSetup();
    exchange.tick(1_000_000, "100");
    control.want = [limit("L1", "BUY", "99", "0.15")];
    await engine.start();
    exchange.tick(1_060_000, "98.9");
    await engine.cycle();
    // 0.15 bought, 0.0000525 of it kept as the fee ($0.0052, not $0.0000525 counted as USDC).
    expect(engine.summary().position.size).toBe("0.1499475");
    expect(engine.summary().position.fees).toBe("0.0051975");

    control.want = [];
    await engine.stop({ closePosition: true });
    await engine.cycle();
    // 0.14 sold at market (SoDEX refuses 0.1499475); the 0.0099475 under one lot stays.
    expect(events.find((e) => e.type === "dust")?.message).toMatch(/0\.0099475 vCOIN/);
    expect(engine.summary().position.size).toBe("0");
    expect((await exchange.snapshot()).position.size).toBe("0.0099475");

    // And a new run starts: the leftover isn't the bot's to close any more.
    await engine.start();
    expect(engine.status).toBe("running");
  });

  it("doesn't try to sell coins worth less than the smallest order", async () => {
    const { engine, exchange, control, events } = spotSetup();
    exchange.tick(1_000_000, "100");
    control.want = [limit("L1", "BUY", "99", "0.06")];
    await engine.start();
    exchange.tick(1_060_000, "98.9");
    await engine.cycle();
    control.want = [];
    await engine.stop({ closePosition: true });
    // 0.05 lots × $98.89 = $4.94, under $5: nothing is sent, the coins stay.
    expect(events.some((e) => e.type === "close")).toBe(false);
    expect(events.find((e) => e.type === "dust")?.message).toMatch(
      /is below SoDEX's smallest sell/,
    );
    expect(engine.summary().position.size).toBe("0");
  });
});

describe("restarting a stopped bot", () => {
  it("starts a fresh run when the position is flat", async () => {
    const { engine, exchange, control, events } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    await engine.stop({ closePosition: true });
    await engine.start();
    expect(engine.status).toBe("running");
    expect(events.some((e) => e.type === "new-run")).toBe(true);
  });

  it("sends one-shot keys again in a new run (a fresh strategy numbers them from the start)", async () => {
    const { engine, exchange, control, calls } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("T1", "BUY", "77100", "0.0002", { ioc: true, once: true })];
    await engine.start();
    await engine.cycle();
    expect(calls.fills).toHaveLength(1);
    control.want = [limit("T2", "SELL", "76900", "0.0002", { ioc: true, once: true })];
    await engine.cycle();
    await engine.cycle();
    expect(calls.fills).toHaveLength(2);
    control.want = [];
    await engine.stop({ closePosition: true });

    control.want = [limit("T1", "BUY", "77100", "0.0002", { ioc: true, once: true })];
    await engine.start();
    await engine.cycle();
    expect(calls.fills).toHaveLength(3);
    expect(engine.summary().position.size).toBe("0.0002");
  });

  it("refuses when the position the stopped bot holds can't be closed", async () => {
    const { engine, exchange, control } = setup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("L1", "BUY", "76000", "0.0002")];
    await engine.start();
    exchange.tick(1_060_000, "75990");
    await engine.cycle();
    await engine.stop({ closePosition: false });
    // The exchange refuses the closing order.
    exchange.place = async (orders) =>
      orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, error: "rejected" }));
    await expect(engine.start()).rejects.toThrow(/Couldn't close/);
    expect(engine.status).toBe("stopped");
  });
});

describe("quoting strategies", () => {
  function quotingSetup(
    budget?: { remaining: number; quota: number },
    deadManShared?: () => boolean,
  ) {
    const s = scripted();
    const quoting = { ...s, strategy: { ...s.strategy, quoting: true } };
    const ctx = setup({ scripted: quoting, ...(deadManShared ? { deadManShared } : {}) });
    const armed: (number | undefined)[] = [];
    Object.defineProperty(ctx.exchange, "scheduleCancel", {
      value: async (at: number | undefined) => {
        armed.push(at);
      },
    });
    if (budget) Object.defineProperty(ctx.exchange, "actionBudget", { value: async () => budget });
    return { ...ctx, armed };
  }

  it("arms the dead-man switch while running and clears it on stop", async () => {
    const { engine, exchange, control, armed } = quotingSetup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    expect(armed[0]).toBe(1_000_000 + 60_000);
    await engine.stop({ closePosition: false });
    expect(armed.at(-1)).toBeUndefined();
  });

  it("keeps trying to arm the dead-man switch while SoDEX is unreachable, warning once a minute", async () => {
    const s = scripted();
    const { engine, exchange, control, events } = setup({
      scripted: { ...s, strategy: { ...s.strategy, quoting: true } },
    });
    let down = true;
    let tries = 0;
    Object.defineProperty(exchange, "scheduleCancel", {
      value: async () => {
        tries += 1;
        if (down) throw new Error("network error (write outcome unknown)");
      },
    });
    const clock = (t: number) =>
      Object.defineProperty(exchange, "now", { value: () => t, configurable: true });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    for (const t of [1_001_000, 1_002_000, 1_030_000]) {
      clock(t);
      await engine.cycle();
    }
    const warnings = () => events.filter((e) => e.type === "dead-man").length;
    expect(tries).toBeGreaterThanOrEqual(4);
    expect(warnings()).toBe(1);
    clock(1_061_000);
    await engine.cycle();
    expect(warnings()).toBe(2);
    down = false;
    clock(1_062_000);
    await engine.cycle();
    const armedTries = tries;
    clock(1_063_000);
    await engine.cycle();
    expect(tries).toBe(armedTries); // armed: no more tries until it's due again
    expect(warnings()).toBe(2);
  });

  it("leaves the account-wide dead-man switch armed while another bot relies on it", async () => {
    const { engine, exchange, control, armed } = quotingSetup(undefined, () => true);
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    await engine.stop({ closePosition: false });
    expect(armed).toEqual([1_060_000]); // armed once, never cleared
    expect((await exchange.snapshot()).openOrders).toHaveLength(0); // its own quotes are gone
  });

  it("takes its quotes off the book while paused and puts them back on resume", async () => {
    const { engine, exchange, control } = quotingSetup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    engine.pause("test");
    await engine.cycle();
    expect((await exchange.snapshot()).openOrders).toHaveLength(0);
    engine.resume();
    await engine.cycle();
    expect((await exchange.snapshot()).openOrders).toHaveLength(1);
  });

  it("keeps the market's margin mode when SoDEX won't switch it with a position open", async () => {
    const s = scripted();
    const withSetup = {
      ...s,
      strategy: { ...s.strategy, setup: () => ({ leverage: 3, marginMode: "CROSS" as const }) },
    };
    const { engine, exchange, events } = setup({ scripted: withSetup });
    const calls: string[] = [];
    Object.defineProperty(exchange, "setLeverage", {
      value: async (leverage: number, mode: string) => {
        calls.push(`${leverage}x ${mode}`);
        if (mode === "CROSS") {
          throw new Error(
            "SoDEX /api/v1/perps/trade/leverage failed (code -1, HTTP 200): internal error: cannot update margin mode with open positions",
          );
        }
      },
    });
    exchange.tick(1_000_000, "77000");
    await engine.start();
    expect(calls).toEqual(["3x CROSS", "3x ISOLATED"]);
    expect(engine.status).toBe("running");
    expect(events.map((e) => e.message).join("\n")).toMatch(/keeps isolated margin/);
  });

  it("stops a bot paused for too long, freeing its place, and keeps the position", async () => {
    const { engine, exchange, control, store, bot } = setup({ stopWhenPausedMs: 300_000 });
    const clock = (t: number) =>
      Object.defineProperty(exchange, "now", { value: () => t, configurable: true });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    engine.pause("5 orders rejected in a row (insufficient margin)");
    clock(1_000_000 + 299_000); // under 5 minutes: still paused
    await engine.cycle();
    expect(engine.status).toBe("paused");
    clock(1_000_000 + 301_000); // over 5 minutes: stopped
    await engine.cycle();
    expect(engine.status).toBe("stopped");
    expect(store.getBot(bot.id)?.statusReason).toContain(
      "Paused for 5 min, so stopped to free its place: 5 orders rejected in a row (insufficient margin)",
    );
    expect((await exchange.snapshot()).openOrders).toHaveLength(0);
  });

  it("samples its PnL once a minute with the strategy's numbers, but not in backtests", async () => {
    const s = scripted();
    s.strategy.sample = (state) => ({ fills: state.fills });
    const { engine, exchange, store, bot } = setup({
      scripted: s,
      bot: {
        id: "live1",
        name: "sampled",
        strategy: "scripted",
        symbol: "BTC-USD",
        market: "perps",
        mode: "paper",
        config: {},
        status: "created",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    const clock = (t: number) =>
      Object.defineProperty(exchange, "now", { value: () => t, configurable: true });
    exchange.tick(1_020_000, "77000");
    clock(1_020_000);
    await engine.start();
    await engine.cycle();
    clock(1_050_000); // the same minute: no new sample
    await engine.cycle();
    clock(1_090_000); // the next minute
    await engine.cycle();
    expect(store.listSamples(bot.id, 0)).toEqual([
      { at: 1_020_000, pnl: 0, data: { fills: 0 } },
      { at: 1_080_000, pnl: 0, data: { fills: 0 } },
    ]);

    const backtest = setup();
    backtest.exchange.tick(1_020_000, "77000");
    await backtest.engine.start();
    await backtest.engine.cycle();
    expect(backtest.store.listSamples(backtest.bot.id, 0)).toEqual([]);
  });

  it("resuming in time clears the pause clock", async () => {
    const { engine, exchange, control } = setup({ stopWhenPausedMs: 300_000 });
    const clock = (t: number) =>
      Object.defineProperty(exchange, "now", { value: () => t, configurable: true });
    exchange.tick(1_000_000, "77000");
    control.want = [];
    await engine.start();
    engine.pause("test");
    clock(1_000_000 + 200_000);
    engine.resume();
    engine.pause("test again");
    clock(1_000_000 + 400_000); // 7 min after the first pause, 3 min after the second
    await engine.cycle();
    expect(engine.status).toBe("paused");
  });

  it("cancels its quotes on disconnect instead of leaving them on the book", async () => {
    const { engine, exchange, control, store, bot } = quotingSetup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    expect((await exchange.snapshot()).openOrders).toHaveLength(1);
    await engine.detach();
    expect((await exchange.snapshot()).openOrders).toHaveLength(0);
    expect(store.activeOrders(bot.id)).toHaveLength(0);
  });

  it("stops quoting when the address action budget runs low", async () => {
    const { engine, exchange, control, events } = quotingSetup({ remaining: 500, quota: 10_000 });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76999", "0.0002")];
    await engine.start();
    expect((await exchange.snapshot()).openOrders).toHaveLength(0);
    expect(events.some((e) => /address actions left/.test(e.message))).toBe(true);
  });

  it("tracks maker volume and cost per $1M", async () => {
    const { engine, exchange, control } = quotingSetup();
    exchange.tick(1_000_000, "77000");
    control.want = [limit("Q", "BUY", "76000", "0.0002")];
    await engine.start();
    control.want = [];
    exchange.tick(1_060_000, "75990");
    await engine.cycle();
    const s = engine.summary();
    expect(s.stats.makerVolume).toBe("15.2");
    expect(s.stats.takerVolume).toBe("0");
    expect(s.costPerMillion).toBeDefined();
  });
});
