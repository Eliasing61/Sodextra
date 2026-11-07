import { describe, expect, it } from "vitest";

import { SPOTS_FULL, spotBlock, spots } from "../src/spots.ts";

const owner = (a: string) => a === "0xowner";

describe("early-access run spots", () => {
  it("keeps the owner's place out of the count: 7 people = 6 spots for others", () => {
    expect(spots([], owner, 7)).toEqual({ total: 6, left: 6 });
    expect(spots(["0xowner", "0xa", "0xb"], owner, 7)).toEqual({ total: 6, left: 4 });
  });

  it("refuses a new wallet only when every spot is taken", () => {
    const full = ["0xa", "0xb", "0xc", "0xd", "0xe", "0xf"];
    expect(spots(full, owner, 7).left).toBe(0);
    expect(spotBlock("0xnew", full, owner, 7)).toBe(SPOTS_FULL);
    expect(spotBlock("0xnew", full.slice(1), owner, 7)).toBeUndefined();
  });

  it("always lets the owner and wallets already running through", () => {
    const full = ["0xa", "0xb", "0xc", "0xd", "0xe", "0xf"];
    expect(spotBlock("0xowner", full, owner, 7)).toBeUndefined();
    expect(spotBlock("0xa", full, owner, 7)).toBeUndefined();
  });
});
