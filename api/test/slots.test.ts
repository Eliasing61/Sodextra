import { describe, expect, it } from "vitest";

import { fits, slotsFor, slotsUsed } from "../src/slots.ts";

describe("server slots (SoDEX connections)", () => {
  it("counts a Funding Carry bot as two, every other bot as one", () => {
    expect(slotsFor("carry")).toBe(2);
    expect(slotsFor("maker")).toBe(1);
    expect(slotsUsed(["maker", "carry", "profit"])).toBe(4);
  });

  it("keeps the running bots within the limit", () => {
    const seven = ["maker", "maker", "maker", "profit", "profit", "maker", "maker"];
    expect(fits(seven, "maker", 8)).toBe(true); // 8 of 8
    expect(fits(seven, "carry", 8)).toBe(false); // would be 9
    expect(fits(["carry", "carry", "carry"], "carry", 8)).toBe(true); // 8 of 8
    expect(fits(["carry", "carry", "carry", "maker"], "maker", 8)).toBe(true); // 8 of 8
    expect(fits(["carry", "carry", "carry", "maker", "maker"], "maker", 8)).toBe(false); // would be 9
  });
});
