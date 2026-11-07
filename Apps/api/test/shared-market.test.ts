import { describe, expect, it } from "vitest";

import { sharedMarketBlock } from "../src/shared-market.ts";

const bot = (strategy: string, symbol = "BTC-USD", market = "perps") => ({
  strategy,
  symbol,
  market,
});

describe("a Taker Volume bot keeps its market to itself on its wallet", () => {
  it("refuses a taker where another of the wallet's bots trades", () => {
    expect(sharedMarketBlock(bot("taker"), [bot("maker")])).toMatch(
      /Another of your bots trades BTC-USD\. A Taker Volume bot needs the market to itself/,
    );
  });

  it("refuses another bot where the wallet's taker trades", () => {
    expect(sharedMarketBlock(bot("grid"), [bot("taker")])).toMatch(
      /Your Taker Volume bot trades BTC-USD/,
    );
    expect(sharedMarketBlock(bot("taker"), [bot("taker")])).toBeDefined();
  });

  it("allows other markets, spot pairs, and bots that don't trade at market together", () => {
    expect(sharedMarketBlock(bot("taker"), [bot("maker", "ETH-USD")])).toBeUndefined();
    expect(sharedMarketBlock(bot("taker"), [bot("grid", "BTC-USD", "spot")])).toBeUndefined();
    expect(sharedMarketBlock(bot("maker"), [bot("grid")])).toBeUndefined();
    expect(sharedMarketBlock(bot("taker"), [])).toBeUndefined();
  });
});
