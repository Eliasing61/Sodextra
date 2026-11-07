import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isOwner, lockedFor, mayRun, webCreateBlock } from "../src/access.ts";

const OWNER = "0xAAAA000000000000000000000000000000000001";
const INVITED = "0xBBBB000000000000000000000000000000000002";
const OTHER = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.stubEnv("SODEXTRA_OWNER_ADDRESS", OWNER);
  vi.stubEnv("SODEXTRA_PROFIT_ADDRESSES", ` ${INVITED}, not-a-wallet,`);
  vi.stubEnv("SODEXTRA_CARRY_ADDRESSES", "");
  vi.stubEnv("SODEXTRA_SPOT_PROFIT_ADDRESSES", "");
  vi.stubEnv("SODEXTRA_STOCK_ADDRESSES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invite-only bots", () => {
  it("lets the owner and invited wallets run Edge, in any letter case", () => {
    expect(mayRun("profit", OWNER)).toBe(true);
    expect(mayRun("profit", OWNER.toLowerCase())).toBe(true);
    expect(mayRun("profit", INVITED)).toBe(true);
    // An Edge invite doesn't open Funding Carry.
    expect(mayRun("carry", INVITED)).toBe(false);
  });

  it("refuses invite-only bots to everyone else (and to no wallet)", () => {
    expect(mayRun("profit", OTHER)).toBe(false);
    expect(mayRun("profit", undefined)).toBe(false);
    expect(lockedFor(OTHER)).toEqual(["profit", "carry", "spot-profit", "stock"]);
    expect(lockedFor(OWNER)).toEqual([]);
  });

  it("opens Maker Volume, Grid and Taker Volume to every wallet", () => {
    for (const strategy of ["maker", "grid", "taker"]) {
      expect(mayRun(strategy, OTHER)).toBe(true);
    }
  });

  it("doesn't mistake inherited object keys for bot types", () => {
    expect(mayRun("constructor", OTHER)).toBe(true);
    expect(mayRun("toString", undefined)).toBe(true);
  });

  it("knows the owner's wallet in any letter case", () => {
    expect(isOwner(OWNER)).toBe(true);
    expect(isOwner(OWNER.toLowerCase())).toBe(true);
    expect(isOwner(OTHER)).toBe(false);
  });

  it("has no owner when none is set", () => {
    vi.stubEnv("SODEXTRA_OWNER_ADDRESS", "");
    expect(isOwner(OWNER)).toBe(false);
    expect(mayRun("profit", OWNER)).toBe(false);
    expect(mayRun("profit", INVITED)).toBe(true);
  });
});

describe("bot types the website may create", () => {
  it("allows the website's bot types", () => {
    for (const strategy of ["maker", "profit", "spot-profit", "stock", "taker", "carry", "grid"]) {
      expect(webCreateBlock(strategy)).toBeUndefined();
    }
  });

  it("refuses probes, carry legs and unknown or missing types", () => {
    expect(webCreateBlock("probe")).toBe('"probe" bots can\'t be created from the website.');
    expect(webCreateBlock("carry-leg")).toBe(
      '"carry-leg" bots can\'t be created from the website.',
    );
    expect(webCreateBlock("constructor")).toBeDefined();
    expect(webCreateBlock("")).toBe("The bot file has no strategy.");
  });
});
