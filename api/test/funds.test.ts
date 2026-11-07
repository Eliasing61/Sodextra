import { describe, expect, it } from "vitest";

import { freeNeed, freeShortfall, marginNeed } from "../src/funds.ts";

// Stored configs are the parsed ones: decimals as strings.
const PERPS_GRID = {
  type: "neutral",
  lower: "90000",
  upper: "110000",
  grids: 20,
  spacing: "arithmetic",
  investment: "250",
  leverage: 5,
  onStop: "cancel_and_close",
  window: 20,
};
const SPOT_GRID = { ...PERPS_GRID, type: "spot", investment: "120", leverage: 1 };

describe("marginNeed", () => {
  it("counts a perps Grid bot's whole investment, whatever its leverage", () => {
    expect(marginNeed(PERPS_GRID)).toBe(250);
    expect(marginNeed({ ...PERPS_GRID, leverage: 10 })).toBe(250);
  });

  it("counts nothing for a spot Grid bot (it pays from the spot account)", () => {
    expect(marginNeed(SPOT_GRID, "spot")).toBe(0);
  });

  it("counts one trade's position for a Taker Volume bot, with room for slippage and fees", () => {
    expect(marginNeed({ orderSize: "500", roundSec: 15, holdSec: 2, leverage: 5 })).toBe(120);
  });

  it("keeps sizing maker-style and Funding Carry bots as before", () => {
    expect(marginNeed({ orderSize: "12", levels: 1, maxInventory: "36", leverage: 3 })).toBe(16);
    expect(marginNeed({ size: "100", leverage: 2 })).toBe(50);
    expect(marginNeed({})).toBe(0);
    expect(marginNeed(undefined)).toBe(0);
  });
});

describe("freeShortfall", () => {
  it("names what a perps bot needs free and what the account has", () => {
    expect(freeShortfall(PERPS_GRID, "perps", 250)).toBeUndefined();
    expect(freeShortfall({ ...PERPS_GRID, investment: "50" }, "perps", 20)).toBe(
      "Not enough free balance in your SoDEX perps account: this bot needs $50.00 and the account has $20.00 free. " +
        "Deposit USDC on sodex.com, or lower the investment.",
    );
    // Maker Volume: (maxInventory + one quote per level) over leverage, as its own check.
    expect(
      freeShortfall({ orderSize: "12", levels: 1, maxInventory: "36", leverage: 3 }, "perps", 0),
    ).toBe(
      "Not enough free balance in your SoDEX perps account: this bot needs $16.00 and the account has $0.00 free. " +
        "Deposit USDC on sodex.com, or use a smaller size or more leverage.",
    );
  });

  it("asks a spot Grid bot for its whole investment, Spot Edge for the most coin it holds", () => {
    expect(freeNeed(SPOT_GRID, "spot")).toBe(120);
    expect(freeNeed({ orderSize: "15", maxInventory: "45" }, "spot")).toBe(45);
    expect(freeShortfall(SPOT_GRID, "spot", 119.5)).toBe(
      "Not enough USDC in your SoDEX spot account: this bot needs $120.00 there and it has $119.50. " +
        "Move USDC from perps to spot (or deposit) on sodex.com, or lower the investment.",
    );
    expect(freeShortfall({ orderSize: "15", maxInventory: "45" }, "spot", 45)).toBeUndefined();
  });

  it("says nothing for a config it can't size", () => {
    expect(freeShortfall({}, "perps", 0)).toBeUndefined();
  });
});
