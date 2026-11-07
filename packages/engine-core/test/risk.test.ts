import { describe, expect, it } from "vitest";

import { describeRisk, parseRiskSettings } from "../src/index.ts";
import { limit, setup } from "./helpers.ts";

describe("parseRiskSettings", () => {
  it("accepts numbers or strings and canonicalises decimals", () => {
    expect(
      parseRiskSettings({ maxNotional: 50, maxLoss: "2.50", maxOpenOrders: 10, maxLeverage: 3 }),
    ).toEqual({
      maxNotional: "50",
      maxPosition: undefined,
      maxLoss: "2.5",
      maxOpenOrders: 10,
      maxLeverage: 3,
    });
    expect(parseRiskSettings(undefined)).toEqual({});
  });

  it.each([
    [{ maxNotional: 0 }, /greater than 0/],
    [{ maxLoss: "abc" }, /number/],
    [{ maxOpenOrders: 1.5 }, /whole number/],
    [{ maxLeverage: 0 }, /whole number/],
    [{ maxNotionl: 5 }, /Unknown risk setting/],
    [[1], /object/],
  ])("rejects %j", (raw, error) => {
    expect(() => parseRiskSettings(raw)).toThrow(error);
  });

  it("describes the limits that are set", () => {
    expect(describeRisk({ maxNotional: "50", maxLoss: "5" })).toBe(
      "max exposure (USDC) 50, max loss before stopping (USDC) 5",
    );
    expect(describeRisk({})).toBe("none set");
  });
});

describe("engine risk limits", () => {
  it("risk.maxPosition counts resting orders that would add to the position", async () => {
    const { engine, exchange, store, control, events, bot } = setup({
      risk: { maxPosition: "0.0005" },
    });
    exchange.tick(1_000_000, "77000");
    control.want = [
      limit("B1", "BUY", "76000", "0.0002"),
      limit("B2", "BUY", "75000", "0.0002"),
      limit("B3", "BUY", "74000", "0.0002"), // long could reach 0.0006 → skipped
      limit("S1", "SELL", "78000", "0.0002"), // short side has its own room
    ];
    await engine.start();
    expect(
      store
        .activeOrders(bot.id)
        .map((o) => o.key)
        .sort(),
    ).toEqual(["B1", "B2", "S1"]);
    expect(events.some((e) => /risk.maxPosition/.test(e.message))).toBe(true);
  });

  it("risk.maxOpenOrders caps how many orders rest at once", async () => {
    const { engine, exchange, store, control, bot } = setup({ risk: { maxOpenOrders: 2 } });
    exchange.tick(1_000_000, "77000");
    control.want = [1, 2, 3].map((i) => limit(`B${i}`, "BUY", String(76000 - i * 100), "0.0002"));
    await engine.start();
    expect(store.activeOrders(bot.id)).toHaveLength(2);
  });

  it("a start after a stop that left a position closes it first, then runs", async () => {
    const { engine, exchange, control, events } = setup({});
    exchange.tick(1_000_000, "77000");
    control.want = [limit("B1", "BUY", "76000", "0.001")];
    await engine.start();
    control.want = [];
    exchange.tick(1_060_000, "75990"); // fills the buy
    await engine.cycle();
    await engine.stop({ closePosition: false });
    expect(engine.summary().position.size).toBe("0.001");

    exchange.tick(1_120_000, "76000");
    await engine.start();
    expect(engine.summary().position.size).toBe("0");
    expect(engine.status).toBe("running");
    expect(events.some((e) => e.type === "close-leftover")).toBe(true);
  });

  it("a start after a stop starts flat when the position was closed outside the bot", async () => {
    const { engine, exchange, control, events } = setup({});
    exchange.tick(1_000_000, "77000");
    control.want = [limit("B1", "BUY", "76000", "0.001")];
    await engine.start();
    control.want = [];
    exchange.tick(1_060_000, "75990"); // fills the buy
    await engine.cycle();
    await engine.stop({ closePosition: false });

    // Closed by hand on sodex.com: the account holds nothing on this symbol.
    const snapshot = exchange.snapshot.bind(exchange);
    exchange.snapshot = async () => ({ ...(await snapshot()), position: { size: "0" } });
    const placed: unknown[] = [];
    const place = exchange.place.bind(exchange);
    exchange.place = async (orders) => {
      placed.push(...orders);
      return place(orders);
    };
    exchange.tick(1_120_000, "76000");
    await engine.start();
    expect(engine.status).toBe("running");
    expect(engine.summary().position.size).toBe("0");
    expect(placed.some((o) => (o as { kind?: string }).kind === "market")).toBe(false);
    expect(events.some((e) => e.type === "position-matched")).toBe(true);
  });

  it("risk.maxLoss stops the bot and closes the position", async () => {
    const { engine, exchange, control, events } = setup({ risk: { maxLoss: "1" } });
    exchange.tick(1_000_000, "77000");
    control.want = [limit("B1", "BUY", "76000", "0.001")];
    await engine.start();
    control.want = [];
    exchange.tick(1_060_000, "75990"); // fills the buy
    await engine.cycle();
    expect(engine.status).toBe("running");

    exchange.tick(1_120_000, "74900"); // −1.1 USDC unrealised
    await engine.cycle();
    await engine.cycle(); // pick up the closing fill
    expect(engine.status).toBe("stopped");
    expect(engine.summary().statusReason).toMatch(/max loss/);
    expect(engine.summary().position.size).toBe("0");
    expect(events.some((e) => e.type === "max-loss")).toBe(true);

    // Started again: a new run gets the full limit (the earlier loss doesn't count).
    exchange.tick(1_180_000, "74900");
    await engine.start();
    await engine.cycle();
    expect(engine.status).toBe("running");
  });
});
