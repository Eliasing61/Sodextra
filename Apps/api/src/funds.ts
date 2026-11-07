/** Taker Volume: margin per trade, as a multiple of its size over the leverage. */
const TAKER_MARGIN_ROOM = 1.2;

/**
 * What a bot needs from its SoDEX account to start (main.ts marginCheck and spotCheck).
 * Configs are the parsed ones the store keeps: decimals may be strings.
 */

/** A Grid bot's config: sized by its investment rather than per order. */
const isGrid = (c: Record<string, unknown>) =>
  c.orderSize === undefined && c.investment !== undefined;

/** Worst-case margin of a perps bot: for maker-style bots, full inventory plus one quote per level, over leverage. */
export function marginNeed(config: unknown, market = "perps"): number {
  // Spot bots pay from the spot account, not perps margin (freeNeed).
  if (market === "spot") return 0;
  const c = (config ?? {}) as Record<string, unknown>;
  // Grid: its investment is the most margin it uses (leverage sizes the orders, not the margin).
  if (isGrid(c)) return Number(c.investment) || 0;
  // Funding Carry: the perp short's margin (its spot side is funded separately).
  if (c.orderSize === undefined && Number(c.size) > 0)
    return Number(c.size) / Number(c.leverage ?? 2);
  const size = Number(c.orderSize ?? 0);
  if (!(size > 0)) return 0;
  // Taker Volume: one trade's position at a time (its config alone has roundSec).
  if (c.roundSec !== undefined) return (size * TAKER_MARGIN_ROOM) / Number(c.leverage ?? 5);
  // Both bots set maxInventory (bot files from the first Profit Maker had maxEntries).
  const inventory = Number(
    c.maxInventory ?? (Number(c.maxEntries) > 0 ? size * Number(c.maxEntries) : size * 3),
  );
  const levels = Number(c.levels ?? 1);
  const leverage = Number(c.leverage ?? 3);
  return (inventory + levels * size) / leverage;
}

/**
 * What a bot must have free to start (USDC): margin in the perps account, or USDC in the
 * spot account for spot bots, which pay in full: a Grid bot its investment (starting coins
 * and buys), Spot Edge the most coin it holds. The same figures as each bot's own start
 * check, and as the builder's "Balance needed".
 */
export function freeNeed(config: unknown, market = "perps"): number {
  if (market !== "spot") return marginNeed(config, market);
  const c = (config ?? {}) as Record<string, unknown>;
  return Number((isGrid(c) ? c.investment : (c.maxInventory ?? c.orderSize)) ?? 0) || 0;
}

/**
 * Why a bot can't start with `free` USDC (the perps account's free margin, or the spot
 * account's USDC), if it can't, in words a user can act on.
 */
export function freeShortfall(config: unknown, market: string, free: number): string | undefined {
  const need = freeNeed(config, market);
  if (!(need > 0) || free >= need) return undefined;
  const grid = isGrid((config ?? {}) as Record<string, unknown>);
  const needs = `$${need.toFixed(2)}`;
  const has = `$${Math.max(0, free).toFixed(2)}`;
  if (market === "spot")
    return (
      `Not enough USDC in your SoDEX spot account: this bot needs ${needs} there and it has ${has}. ` +
      `Move USDC from perps to spot (or deposit) on sodex.com, or ${grid ? "lower the investment" : "use a smaller size"}.`
    );
  return (
    `Not enough free balance in your SoDEX perps account: this bot needs ${needs} and the account has ${has} free. ` +
    `Deposit USDC on sodex.com, or ${grid ? "lower the investment" : "use a smaller size or more leverage"}.`
  );
}
