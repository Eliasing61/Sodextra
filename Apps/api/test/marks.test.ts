import type { SodexClient } from "@sodextra/sodex-client";
import { describe, expect, it } from "vitest";

import { MarkCache } from "../src/marks.ts";

/** A SoDEX whose ticker calls stay open until the test answers them. */
function fakeSodex() {
  const calls: ((price: string) => void)[] = [];
  const tickers = () =>
    new Promise<{ symbol: string; markPrice: string }[]>((resolve) => {
      calls.push((price) => resolve([{ symbol: "BTC-USD", markPrice: price }]));
    });
  const client = { perps: { tickers }, spot: { tickers } } as unknown as Pick<
    SodexClient,
    "perps" | "spot"
  >;
  return { client, calls };
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

describe("MarkCache", () => {
  it("waits for SoDEX only until it has prices, then answers at once and refreshes behind", async () => {
    const { client, calls } = fakeSodex();
    let now = 1_000_000;
    const marks = new MarkCache(client, () => now);
    const perps = [{ market: "perps" as const }];

    // No prices yet: the first request waits for them.
    const first = marks.refresh(perps);
    expect(await settled(first)).toBe(false);
    calls[0]!("76000");
    await first;
    expect(marks.get("perps", "BTC-USD")).toBe("76000");

    // Fresh: no new call.
    now += 2_000;
    await marks.refresh(perps);
    expect(calls).toHaveLength(1);

    // Older than 5 s: the request answers at once with the last price; the new one loads behind.
    now += 4_000;
    expect(await settled(marks.refresh(perps))).toBe(true);
    expect(marks.get("perps", "BTC-USD")).toBe("76000");
    expect(calls).toHaveLength(2);
    // A second request meanwhile shares that call.
    await marks.refresh(perps);
    expect(calls).toHaveLength(2);
    calls[1]!("75500");
    await new Promise((r) => setTimeout(r, 0));
    expect(marks.get("perps", "BTC-USD")).toBe("75500");
  });
});
