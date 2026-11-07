import { describe, expect, it } from "vitest";

import {
  canonicalDecimal,
  checkOrder,
  isCanonicalDecimal,
  minQuantityForNotional,
  OrderSide,
  OrderType,
  roundPrice,
  roundQuantity,
  roundToIncrement,
  type PerpsSymbol,
} from "../src/index.ts";

// BTC-USD perps filters as returned by mainnet on 2026-10-30.
const BTC: PerpsSymbol = {
  id: 1,
  name: "BTC-USD",
  displayName: "BTC-USD",
  baseCoin: "BTC",
  quoteCoinID: 0,
  quoteCoin: "vUSDC",
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

describe("canonical decimals", () => {
  it.each([
    ["00123", "123"],
    ["+32.1", "32.1"],
    ["32.100", "32.1"],
    ["0.500", "0.5"],
    ["1.234e+2", "123.4"],
    ["001.230", "1.23"],
    ["-0.000", "0"],
    ["1e-8", "0.00000001"],
  ])("%s -> %s (docs table)", (input, expected) => {
    expect(canonicalDecimal(input)).toBe(expected);
  });

  it("detects non-canonical strings", () => {
    expect(isCanonicalDecimal("0.5")).toBe(true);
    expect(isCanonicalDecimal("0.50")).toBe(false);
    expect(isCanonicalDecimal("abc")).toBe(false);
  });
});

describe("rounding to tick and step", () => {
  it("rounds prices and quantities exactly, without float error", () => {
    expect(roundToIncrement("0.3", "0.1", "down")).toBe("0.3");
    expect(roundPrice(BTC, "77571.6")).toBe("77572");
    expect(roundPrice(BTC, "77571.6", "down")).toBe("77571");
    expect(roundQuantity(BTC, "0.000494999")).toBe("0.00049");
    expect(roundToIncrement("2236.24", "0.1", "up")).toBe("2236.3");
  });

  it("finds the minimum quantity that clears minNotional", () => {
    expect(minQuantityForNotional(BTC, "77571")).toBe("0.00013");
  });
});

describe("checkOrder", () => {
  it("accepts the grid spec's worked-example order", () => {
    expect(
      checkOrder(BTC, {
        side: OrderSide.BUY,
        type: OrderType.LIMIT,
        price: "77000",
        quantity: "0.00049",
        markPrice: "77571",
      }),
    ).toEqual([]);
  });

  it("flags tick, step, notional and price-band violations", () => {
    const problems = checkOrder(BTC, {
      side: OrderSide.BUY,
      type: OrderType.LIMIT,
      price: "90000.5",
      quantity: "0.000001",
      markPrice: "77571",
    });
    expect(problems.join("\n")).toMatch(/tickSize/);
    expect(problems.join("\n")).toMatch(/stepSize/);
    expect(problems.join("\n")).toMatch(/minNotional/);
    expect(problems.join("\n")).toMatch(/band/);
  });

  it("skips the notional check for reduce-only orders, like the gateway", () => {
    expect(
      checkOrder(BTC, {
        side: OrderSide.SELL,
        type: OrderType.LIMIT,
        price: "77000",
        quantity: "0.00001",
        reduceOnly: true,
      }),
    ).toEqual([]);
  });

  it("rejects halted symbols", () => {
    expect(
      checkOrder(
        { ...BTC, status: "HALT" },
        { side: 1, type: 1, price: "77000", quantity: "0.001" },
      ),
    ).toContain("symbol BTC-USD is HALT");
  });
});
