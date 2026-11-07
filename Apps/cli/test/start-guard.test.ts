import { describe, expect, it } from "vitest";

import { positionBlocksStart } from "../src/commands/run.ts";

describe("positionBlocksStart", () => {
  it("lets a run start on a flat account", () => {
    expect(positionBlocksStart(undefined, "0")).toBe(false);
    expect(positionBlocksStart("0.00014", "0")).toBe(false);
  });

  it("refuses a position the bot didn't open", () => {
    // A new bot, or a stopped one that left nothing.
    expect(positionBlocksStart(undefined, "0.001")).toBe(true);
    expect(positionBlocksStart("0", "-0.00007")).toBe(true);
    // Seen 2026-11-05: the stopped bot left a long; another bot then turned it into a short.
    expect(positionBlocksStart("0.00014", "-0.00007")).toBe(true);
    // More than the bot left: someone added to it.
    expect(positionBlocksStart("0.00014", "0.00028")).toBe(true);
  });

  it("lets a stopped bot start on what's left of its own position (it closes that first)", () => {
    expect(positionBlocksStart("0.00014", "0.00014")).toBe(false);
    expect(positionBlocksStart("-0.0002", "-0.0001")).toBe(false);
  });
});
