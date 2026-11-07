import type { DesiredOrder, Strategy, ValidationResult } from "@sodextra/engine-core";
import {
  canonicalDecimal,
  checkOrder,
  minQuantityForNotional,
  OrderSide,
  OrderType,
  roundPrice,
  toDecimal,
} from "@sodextra/sodex-client";

/**
 * Engine test strategy: keeps ONE post-only order a fixed distance from the
 * market and moves it when the price drifts. It is meant to rest without
 * filling, so it exercises placing, cancelling, re-pricing, restarts and
 * recovery at no cost. Not a trading strategy.
 */
export interface ProbeConfig {
  side: "BUY" | "SELL";
  /** Distance from the reference price, in percent (default 3). */
  offsetPct: number;
  /** Move the order when the price drifts this many percent from where it was placed (default 1). */
  repriceAtPct: number;
  /** Order size; default is the smallest size that clears minNotional. */
  quantity?: string | undefined;
}

export interface ProbeState {
  /** Reference price the current order is based on. */
  anchor?: string | undefined;
  reprices: number;
}

function orderFor(config: ProbeConfig, anchor: string, symbol: Parameters<typeof roundPrice>[0]) {
  const factor = toDecimal(1).plus(
    toDecimal(config.offsetPct)
      .div(100)
      .mul(config.side === "BUY" ? -1 : 1),
  );
  const price = roundPrice(
    symbol,
    toDecimal(anchor).mul(factor),
    config.side === "BUY" ? "down" : "up",
  );
  const quantity = config.quantity ?? minQuantityForNotional(symbol, price);
  return { price, quantity };
}

export const probe: Strategy<ProbeConfig, ProbeState> = {
  name: "probe",
  idPrefix: "p",

  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const side = r.side === undefined ? "BUY" : r.side;
    if (side !== "BUY" && side !== "SELL") throw new Error('probe: "side" must be "BUY" or "SELL"');
    const offsetPct = r.offsetPct === undefined ? 3 : Number(r.offsetPct);
    const repriceAtPct = r.repriceAtPct === undefined ? 1 : Number(r.repriceAtPct);
    if (!Number.isFinite(offsetPct) || !Number.isFinite(repriceAtPct)) {
      throw new Error("probe: offsetPct and repriceAtPct must be numbers");
    }
    return {
      side,
      offsetPct,
      repriceAtPct,
      quantity: r.quantity === undefined ? undefined : canonicalDecimal(String(r.quantity)),
    };
  },

  validate(config, env): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (config.offsetPct < 0.5 || config.offsetPct > 4.5) {
      errors.push(
        "offsetPct must be between 0.5 and 4.5 (SoDEX rejects limit prices more than ~5% from mark)",
      );
    }
    if (config.repriceAtPct <= 0 || config.repriceAtPct >= config.offsetPct) {
      errors.push(
        "repriceAtPct must be above 0 and below offsetPct, so the order never gets close to the market",
      );
    }
    const { price, quantity } = orderFor(config, env.markPrice, env.symbol);
    const notional = toDecimal(price).mul(quantity);
    errors.push(
      ...checkOrder(env.symbol, {
        side: config.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
        type: OrderType.LIMIT,
        price,
        quantity,
        ...(env.market === "perps" ? { markPrice: env.markPrice } : {}),
      }),
    );
    if (env.risk.maxNotional !== undefined && notional.gt(env.risk.maxNotional)) {
      errors.push(
        `order notional ${notional.toFixed(2)} exceeds risk.maxNotional ${env.risk.maxNotional}`,
      );
    }
    if (env.risk.maxPosition !== undefined && toDecimal(quantity).gt(env.risk.maxPosition)) {
      errors.push(`order size ${quantity} exceeds risk.maxPosition ${env.risk.maxPosition}`);
    }
    warnings.push(
      "probe is an engine test: its order sits away from the market and is not meant to fill.",
    );
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      summary: [
        `${env.symbol.name} ${env.market}, mark ${env.markPrice}`,
        `post-only ${config.side} ${quantity} @ ${price} (${config.offsetPct}% away, ≈ ${notional.toFixed(2)} USDC)`,
        `moves the order when price drifts ${config.repriceAtPct}% from where it was placed`,
      ],
    };
  },

  initialState: () => ({ reprices: 0 }),

  onMarket(ctx, state) {
    const mark = ctx.mark();
    if (mark === undefined) return;
    if (state.anchor === undefined) {
      state.anchor = mark;
      return;
    }
    const drift = toDecimal(mark).minus(state.anchor).abs().div(state.anchor).mul(100);
    if (drift.gt(ctx.config.repriceAtPct)) {
      ctx.log("info", `Price moved ${drift.toFixed(2)}% → re-pricing`);
      state.anchor = mark;
      state.reprices += 1;
    }
  },

  desired(ctx, state): DesiredOrder[] {
    if (state.anchor === undefined) return [];
    const { price, quantity } = orderFor(ctx.config, state.anchor, ctx.symbol);
    return [
      { key: "probe", side: ctx.config.side, kind: "limit", price, quantity, postOnly: true },
    ];
  },

  onFill(ctx, _state, fill) {
    ctx.log("warn", `Probe order filled (${fill.side} ${fill.quantity} @ ${fill.price}); stopping`);
    ctx.requestStop("probe order filled", { closePosition: false });
  },
};
