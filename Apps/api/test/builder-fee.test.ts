import { builder } from "@sodextra/cli/env";
import { describe, expect, it } from "vitest";

import { approvalNeeded, launchFee, type BuilderStatus } from "../src/builder.ts";

const status = (approvedFee: number): BuilderStatus => ({
  required: true,
  approved: approvedFee >= builder.fee,
  builderID: builder.id,
  fee: builder.fee,
  approvedFee,
});

describe("launchFee", () => {
  it("gives a start someone asked for the current fee (the start checked the approval)", () => {
    expect(launchFee(status(builder.fee), false)).toBe(builder.fee);
    expect(launchFee(undefined, false)).toBe(builder.fee);
  });

  it("never lets a bot restarting by itself ask more than its user approved", () => {
    // Approved the old 0.1 bp (1), not yet the new rate: keeps 0.1 bp.
    expect(launchFee(status(1), true)).toBe(Math.min(builder.fee, 1));
    expect(launchFee(status(builder.fee), true)).toBe(builder.fee);
    expect(launchFee(status(0), true)).toBe(0);
    // SoDEX couldn't be asked: no more than the 0.1 bp every earlier user approved.
    expect(launchFee(undefined, true)).toBe(Math.min(builder.fee, 1));
  });
});

describe("approvalNeeded", () => {
  it("tells a user who approved the old fee that it changed", () => {
    if (builder.fee <= 1) return; // the raise isn't on here
    expect(approvalNeeded(status(1))).toBe(
      `Sodextra's fee is now ${builder.fee / 10} bp (you approved 0.1 bp). Approve the new fee to start or restart bots: one wallet signature, no money moves.`,
    );
  });

  it("asks a new user for a first approval", () => {
    expect(approvalNeeded(status(0))).toMatch(/^Approve Sodextra's [\d.]+ bp fee in Setup first/);
  });
});
