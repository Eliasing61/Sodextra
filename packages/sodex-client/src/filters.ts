import { Decimal } from "decimal.js";

import { canonicalDecimal, toDecimal, type DecimalInput } from "./decimal.ts";
import { OrderSide, OrderType } from "./enums.ts";
import type { MarketSymbol } from "./types/market.ts";

export type RoundMode = "down" | "up" | "nearest";

/** Round `value` to a multiple of `increment` (tick or step) and return a canonical decimal string. */
export function roundToIncrement(
  value: DecimalInput,
  increment: DecimalInput,
  mode: RoundMode = "nearest",
): string {
  const v = toDecimal(value);
  const inc = toDecimal(increment);
  if (inc.lte(0)) throw new Error("increment must be positive");
  const units = v.div(inc);
  const rounding =
    mode === "down"
      ? Decimal.ROUND_FLOOR
      : mode === "up"
        ? Decimal.ROUND_CEIL
        : Decimal.ROUND_HALF_UP;
  return canonicalDecimal(units.toDecimalPlaces(0, rounding).mul(inc));
}

export function roundPrice(
  symbol: MarketSymbol,
  price: DecimalInput,
  mode: RoundMode = "nearest",
): string {
  return roundToIncrement(price, symbol.tickSize, mode);
}

/** Quantities round down by default so an order never exceeds the intended size. */
export function roundQuantity(
  symbol: MarketSymbol,
  quantity: DecimalInput,
  mode: RoundMode = "down",
): string {
  return roundToIncrement(quantity, symbol.stepSize, mode);
}

/** Smallest quantity (on the step grid) whose notional at `price` reaches minNotional and minQuantity. */
export function minQuantityForNotional(symbol: MarketSymbol, price: DecimalInput): string {
  const byNotional = toDecimal(
    roundToIncrement(toDecimal(symbol.minNotional).div(toDecimal(price)), symbol.stepSize, "up"),
  );
  const minQty = toDecimal(symbol.minQuantity);
  return canonicalDecimal(Decimal.max(byNotional, minQty));
}

export interface OrderCheckInput {
  side: OrderSide;
  type: OrderType;
  price?: DecimalInput;
  quantity?: DecimalInput;
  reduceOnly?: boolean;
  /** Needed for the limit price band check (perps uses mark price). */
  markPrice?: DecimalInput;
}

/**
 * Mirrors the gateway's documented pre-trade filters so we can reject an order
 * locally with a clear reason instead of burning a request. Returns [] when OK.
 */
export function checkOrder(symbol: MarketSymbol, order: OrderCheckInput): string[] {
  const problems: string[] = [];
  const isZero = (s: string) => toDecimal(s).isZero();
  const multipleOf = (v: Decimal, inc: string) => v.mod(toDecimal(inc)).isZero();

  if (symbol.status !== undefined && symbol.status !== "TRADING") {
    problems.push(`symbol ${symbol.name} is ${symbol.status}`);
  }

  if (order.price !== undefined) {
    const p = toDecimal(order.price);
    if (p.lte(0)) problems.push("price must be positive");
    if (p.decimalPlaces() > symbol.pricePrecision)
      problems.push(`price has more than ${symbol.pricePrecision} decimals`);
    if (!multipleOf(p, symbol.tickSize))
      problems.push(`price is not a multiple of tickSize ${symbol.tickSize}`);
    if (!isZero(symbol.minPrice) && p.lt(symbol.minPrice))
      problems.push(`price below minPrice ${symbol.minPrice}`);
    if (!isZero(symbol.maxPrice) && p.gt(symbol.maxPrice))
      problems.push(`price above maxPrice ${symbol.maxPrice}`);

    if (order.type === OrderType.LIMIT && order.markPrice !== undefined) {
      const mark = toDecimal(order.markPrice);
      if (order.side === OrderSide.BUY) {
        const cap = mark.mul(toDecimal(symbol.buyLimitUpRatio).plus(1));
        if (p.gt(cap))
          problems.push(
            `buy price above band (mark × (1 + ${symbol.buyLimitUpRatio}) = ${cap.toFixed()})`,
          );
      } else {
        const floor = mark.mul(toDecimal(1).minus(symbol.sellLimitDownRatio));
        if (p.lt(floor))
          problems.push(
            `sell price below band (mark × (1 − ${symbol.sellLimitDownRatio}) = ${floor.toFixed()})`,
          );
      }
    }
  } else if (order.type === OrderType.LIMIT) {
    problems.push("limit orders need a price");
  }

  if (order.quantity !== undefined) {
    const q = toDecimal(order.quantity);
    const isMarket = order.type === OrderType.MARKET;
    const minQ = isMarket ? symbol.marketMinQuantity : symbol.minQuantity;
    const maxQ = isMarket ? symbol.marketMaxQuantity : symbol.maxQuantity;
    if (q.lte(0)) problems.push("quantity must be positive");
    if (q.decimalPlaces() > symbol.quantityPrecision)
      problems.push(`quantity has more than ${symbol.quantityPrecision} decimals`);
    if (!multipleOf(q, symbol.stepSize))
      problems.push(`quantity is not a multiple of stepSize ${symbol.stepSize}`);
    if (!isZero(minQ) && q.lt(minQ)) problems.push(`quantity below minimum ${minQ}`);
    if (!isZero(maxQ) && q.gt(maxQ)) problems.push(`quantity above maximum ${maxQ}`);

    if (order.price !== undefined && !order.reduceOnly) {
      const notional = q.mul(toDecimal(order.price));
      if (!isZero(symbol.minNotional) && notional.lt(symbol.minNotional)) {
        problems.push(`notional ${notional.toFixed()} below minNotional ${symbol.minNotional}`);
      }
      if (!isZero(symbol.maxNotional) && notional.gt(symbol.maxNotional)) {
        problems.push(`notional ${notional.toFixed()} above maxNotional ${symbol.maxNotional}`);
      }
    }
  }

  return problems;
}
