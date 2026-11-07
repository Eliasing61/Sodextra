/**
 * A Taker Volume bot trades at market. On a market where the same wallet has orders
 * resting (another of its bots), its orders could fill against them: a trade with itself,
 * a wash trade. SoDEX has no self-trade prevention, so a taker bot needs its market to
 * itself on its wallet. Paper bots don't trade on the account and don't count.
 */
export interface MarketUse {
  strategy: string;
  market: string;
  symbol: string;
}

export const TAKER = "taker";

/** Why this live bot can't start next to the wallet's other running live bots, if it can't. */
export function sharedMarketBlock(bot: MarketUse, others: MarketUse[]): string | undefined {
  const same = others.filter((o) => o.market === bot.market && o.symbol === bot.symbol);
  if (same.length === 0) return undefined;
  if (bot.strategy === TAKER) {
    return `Another of your bots trades ${bot.symbol}. A Taker Volume bot needs the market to itself, so it never trades against your own orders: pick another market, or stop that bot first.`;
  }
  if (same.some((o) => o.strategy === TAKER)) {
    return `Your Taker Volume bot trades ${bot.symbol}. Pick another market, or stop it first, so your bots never trade with each other.`;
  }
  return undefined;
}
