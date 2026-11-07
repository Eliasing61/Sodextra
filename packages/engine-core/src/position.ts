import { canonicalDecimal, toDecimal } from "@sodextra/sodex-client";

import type { Fill, Side } from "./types.ts";

export interface PositionState {
  /** Signed base size from this bot's fills. */
  size: string;
  /** Average entry price of the open size ("0" when flat). */
  avgEntry: string;
  /** Realised PnL in quote, before fees. */
  realizedPnl: string;
  /** Fees paid in quote (negative = rebates received). */
  fees: string;
  /** Traded notional in quote. */
  volume: string;
  fillCount: number;
}

export const emptyPosition = (): PositionState => ({
  size: "0",
  avgEntry: "0",
  realizedPnl: "0",
  fees: "0",
  volume: "0",
  fillCount: 0,
});

/**
 * Spot (baseCoin set): was this fill's fee taken in the base coin? SoDEX charges a spot fee
 * in the coin received: a buy pays in the base coin, a sell in USDC. The WebSocket copy of
 * a fill doesn't name the coin (the REST copy does), so without it the side decides.
 */
export function feeInBase(fill: Pick<Fill, "side" | "feeCoin">, baseCoin?: string): boolean {
  if (baseCoin === undefined) return false;
  return fill.feeCoin !== undefined ? fill.feeCoin === baseCoin : fill.side === "BUY";
}

/**
 * A spot fill was counted with its fee in one coin and the REST copy names the other:
 * move it. A buy whose fee was in the base coin delivered that much less base, and that
 * fee's quote value is fee × price.
 */
export function correctFeeCoin(
  state: PositionState,
  seen: Pick<Fill, "side" | "feeCoin">,
  fresh: Pick<Fill, "side" | "price" | "fee" | "feeCoin">,
  baseCoin: string | undefined,
): PositionState {
  const was = feeInBase({ side: fresh.side, feeCoin: seen.feeCoin }, baseCoin);
  const now = feeInBase(fresh, baseCoin);
  if (was === now) return state;
  const fee = toDecimal(fresh.fee);
  const inQuote = fee.mul(fresh.price);
  // Moving to the base coin: less base, and the fee is worth fee × price. Back: the reverse.
  const sign = now ? 1 : -1;
  const size =
    fresh.side === "BUY" ? toDecimal(state.size).minus(fee.mul(sign)) : toDecimal(state.size);
  const fees = toDecimal(state.fees).plus(inQuote.minus(fee).mul(sign));
  return { ...state, size: canonicalDecimal(size), fees: canonicalDecimal(fees) };
}

/**
 * Applies a fill to a position with average-cost accounting.
 * Fees charged in the base coin (spot buys) are converted to quote at the fill
 * price and also reduce the base received.
 */
export function applyFill(
  state: PositionState,
  fill: Pick<Fill, "side" | "price" | "quantity" | "fee" | "feeCoin">,
  baseCoin?: string,
): PositionState {
  const price = toDecimal(fill.price);
  let qty = toDecimal(fill.quantity);
  const inBase = feeInBase(fill, baseCoin);
  const feeQuote = inBase ? toDecimal(fill.fee).mul(price) : toDecimal(fill.fee);
  if (inBase && fill.side === "BUY") qty = qty.minus(toDecimal(fill.fee));

  const size = toDecimal(state.size);
  const signed = fill.side === "BUY" ? qty : qty.neg();
  let avg = toDecimal(state.avgEntry);
  let realized = toDecimal(state.realizedPnl);
  const next = size.plus(signed);

  if (size.isZero() || size.gt(0) === signed.gt(0)) {
    // Opening or adding: weighted average entry.
    avg = size.abs().mul(avg).plus(qty.mul(price)).div(size.abs().plus(qty));
  } else {
    // Reducing, closing or flipping.
    const closing = qty.lt(size.abs()) ? qty : size.abs();
    const direction = size.gt(0) ? 1 : -1;
    realized = realized.plus(closing.mul(price.minus(avg)).mul(direction));
    if (next.isZero()) avg = toDecimal(0);
    else if (next.gt(0) !== size.gt(0)) avg = price;
  }

  return {
    size: canonicalDecimal(next),
    avgEntry: canonicalDecimal(avg),
    realizedPnl: canonicalDecimal(realized),
    fees: canonicalDecimal(toDecimal(state.fees).plus(feeQuote)),
    volume: canonicalDecimal(toDecimal(state.volume).plus(qty.mul(price))),
    fillCount: state.fillCount + 1,
  };
}

export function unrealizedPnl(state: PositionState, mark: string | undefined): string {
  if (mark === undefined || toDecimal(state.size).isZero()) return "0";
  return canonicalDecimal(toDecimal(state.size).mul(toDecimal(mark).minus(state.avgEntry)));
}

/** Realised + unrealised − fees. */
export function totalPnl(state: PositionState, mark: string | undefined): string {
  return canonicalDecimal(
    toDecimal(state.realizedPnl).plus(unrealizedPnl(state, mark)).minus(state.fees),
  );
}

export const oppositeSide = (side: Side): Side => (side === "BUY" ? "SELL" : "BUY");
