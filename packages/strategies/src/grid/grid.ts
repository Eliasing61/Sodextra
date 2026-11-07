import type {
  DesiredOrder,
  Side,
  Strategy,
  StrategyContext,
  ValidationEnv,
  ValidationResult,
} from "@sodextra/engine-core";
import { canonicalDecimal, roundPrice, roundQuantity, toDecimal } from "@sodextra/sodex-client";

import { parseGridConfig, type GridConfig } from "./config.ts";
import { LIQUIDATION_BUFFER, planGrid, nearestLine, type GridPlan } from "./math.ts";

/** How far through the market the starting IOC order may reach (well inside SoDEX's 5% band). */
const START_SLIPPAGE = 0.005;
const MAX_START_ATTEMPTS = 3;
/** Spot: the most SoDEX takes from a buy, in the coin (taker + builder fee), for the size check. */
const SPOT_FEE_ALLOWANCE = 0.001;

export interface GridState {
  /** waiting: for data or the trigger price; opening: building the starting position; running; done. */
  phase: "waiting" | "opening" | "running" | "done";
  /** Which way the price must move to hit triggerPrice. */
  triggerDirection?: "up" | "down" | undefined;
  lines?: string[] | undefined;
  quantity?: string | undefined;
  /** Side each line should hold (null = empty). */
  slots: (Side | null)[];
  /** Spot: coins each sell line sells (SoDEX takes a buy's fee in the coin, so less than `quantity`). */
  sellQty?: Record<string, string> | undefined;
  /** Counter orders whose line was still occupied: line → side + the line they pair with. */
  owed: Record<string, { side: Side; from: number }>;
  /** Line of a counter order → the line whose fill created it (for round-trip counting). */
  pairedWith: Record<string, number>;
  start?:
    | { side: Side; quantity: string; filled: string; price?: string | undefined; attempts: number }
    | undefined;
  roundTrips: number;
  /** Gross profit of completed round trips (before fees; fees are tracked by the engine). */
  gridProfit: string;
  outOfRange?: "below" | "above" | undefined;
  /** Config fields the layout was built from; edits to these need a restart. */
  layoutKey?: string | undefined;
  layoutWarned?: boolean | undefined;
  /** Not laid out yet because the price is outside the range. */
  waitingForRange?: boolean | undefined;
  /** When we last logged a range notice (ms). */
  rangeNoticeAt?: number | undefined;
}

/** Only phases worth mentioning; the bot status line already says running/stopped. */
const phaseNote = (s: GridState) =>
  s.waitingForRange
    ? " — waiting for the price to enter the range"
    : s.phase === "waiting"
      ? " — waiting for the trigger price"
      : s.phase === "opening"
        ? " — opening the starting position"
        : s.outOfRange
          ? ` — price ${s.outOfRange} the range`
          : "";

const lineKey = (i: number) => `L${String(i).padStart(3, "0")}`;
const lineIndex = (key: string) => (/^L\d{3}$/.test(key) ? Number(key.slice(1)) : undefined);
const opposite = (side: Side): Side => (side === "BUY" ? "SELL" : "BUY");
const layoutKeyOf = (c: GridConfig) =>
  JSON.stringify([c.type, c.lower, c.upper, c.grids, c.spacing, c.investment, c.leverage]);

function plan(ctx: StrategyContext<GridConfig>, price: string): GridPlan {
  return planGrid({
    config: ctx.config,
    symbol: ctx.symbol,
    market: ctx.market,
    price,
    makerFee: "0",
    builderFee: "0",
  });
}

/**
 * Spot: SoDEX takes a buy's fee in the coin it delivers, so the grid holds a little less than
 * its order size per sell line. Each sell sells what is actually held for it, rounded down to
 * the lot size (the remainder rolls into the next sell), so no sell is ever short of coins.
 */
function fundSells(ctx: StrategyContext<GridConfig>, state: GridState): void {
  if (ctx.market !== "spot") return;
  const sells = state.slots.flatMap((side, i) => (side === "SELL" ? [i] : []));
  if (sells.length === 0) return;
  const each = roundQuantity(ctx.symbol, toDecimal(ctx.position()).div(sells.length), "down");
  state.sellQty = Object.fromEntries(sells.map((i) => [String(i), each]));
}

/**
 * Spot: coins held but not on any other sell line, at most one order's worth (a sell whose
 * line is still taken keeps its coins for later), rounded down to the lot size.
 */
function freeCoins(ctx: StrategyContext<GridConfig>, state: GridState, line: number): string {
  const committed = state.slots.reduce(
    (sum, side, i) =>
      side === "SELL" && i !== line ? sum.plus(state.sellQty?.[i] ?? state.quantity ?? 0) : sum,
    toDecimal(0),
  );
  const free = toDecimal(ctx.position()).minus(committed);
  const capped = free.gt(state.quantity ?? free) ? toDecimal(state.quantity!) : free;
  return capped.gt(0) ? roundQuantity(ctx.symbol, capped, "down") : "0";
}

/** Put a counter order on `line`, paired with the line whose fill created it. */
function assign(
  ctx: StrategyContext<GridConfig>,
  state: GridState,
  line: number,
  side: Side,
  from: number,
): void {
  state.slots[line] = side;
  state.pairedWith[line] = from;
  if (ctx.market === "spot" && side === "SELL")
    (state.sellQty ??= {})[line] = freeCoins(ctx, state, line);
}

function stopWith(ctx: StrategyContext<GridConfig>, state: GridState, reason: string): void {
  if (state.phase === "done") return;
  state.phase = "done";
  ctx.log("warn", reason);
  ctx.requestStop(reason, { closePosition: ctx.config.onStop === "cancel_and_close" });
}

/** Lay the grid out at the current price and move to opening/running. */
function layOut(ctx: StrategyContext<GridConfig>, state: GridState, price: string): void {
  let p: GridPlan;
  try {
    p = plan(ctx, price);
  } catch (error) {
    stopWith(
      ctx,
      state,
      `Cannot start the grid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  state.lines = p.lines;
  state.quantity = p.quantity;
  state.slots = p.lines.map((_, i) =>
    p.buys.includes(i) ? "BUY" : p.sells.includes(i) ? "SELL" : null,
  );
  state.layoutKey = layoutKeyOf(ctx.config);
  if (p.start) {
    // The far-side lines close the starting position: count each close as a round trip from
    // the line next to it, as if that line had opened it (the start price's offset from that
    // line shows in the PnL, not the grid profit).
    const closer = opposite(p.start.side);
    const step = p.start.side === "BUY" ? -1 : 1;
    state.slots.forEach((side, i) => {
      if (side === closer) state.pairedWith[i] = i + step;
    });
    state.start = { side: p.start.side, quantity: p.start.quantity, filled: "0", attempts: 0 };
    state.phase = "opening";
    ctx.log(
      "info",
      `Grid laid out at ${price}: opening a ${p.start.side} position of ${p.start.quantity} first`,
    );
  } else {
    state.phase = "running";
    ctx.log(
      "info",
      `Grid laid out at ${price}: ${p.buys.length} buy lines, ${p.sells.length} sell lines, ${p.quantity} each`,
    );
  }
}

function validate(config: GridConfig, env: ValidationEnv): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const isSpotMarket = env.market === "spot";

  if (isSpotMarket !== (config.type === "spot")) {
    errors.push(
      isSpotMarket
        ? 'spot markets need "type": "spot"'
        : '"type": "spot" needs a spot market ("market": "spot")',
    );
  }
  if (env.symbol.status !== undefined && env.symbol.status !== "TRADING")
    errors.push(`${env.symbol.name} is ${env.symbol.status}`);

  let reference = config.triggerPrice ?? env.markPrice;
  if (
    config.triggerPrice &&
    (toDecimal(config.triggerPrice).lte(config.lower) ||
      toDecimal(config.triggerPrice).gte(config.upper))
  ) {
    errors.push(
      `triggerPrice ${config.triggerPrice} must be inside the range ${config.lower}–${config.upper}`,
    );
  }
  // Outside the range, the bot waits for the price to come in and lays the grid out there
  // (also when it resumes after a restart): plan it as if the price had just entered.
  if (!config.triggerPrice) {
    const below = toDecimal(reference).lte(config.lower);
    if (below || toDecimal(reference).gte(config.upper)) {
      warnings.push(
        `price ${env.markPrice} is ${below ? "below" : "above"} the range: the bot waits until it moves inside, then lays the grid out`,
      );
      const inside = toDecimal(config.upper)
        .minus(config.lower)
        .div(2 * config.grids);
      reference = canonicalDecimal(
        below ? toDecimal(config.lower).plus(inside) : toDecimal(config.upper).minus(inside),
      );
    }
  }
  if (config.stopLossLow && toDecimal(config.stopLossLow).gte(config.lower))
    errors.push(`stop-loss ${config.stopLossLow} must be below lower ${config.lower}`);
  if (config.stopLossHigh && toDecimal(config.stopLossHigh).lte(config.upper))
    errors.push(`stop-loss ${config.stopLossHigh} must be above upper ${config.upper}`);
  if (config.stopLossHigh && (config.type === "long" || config.type === "spot"))
    errors.push(`a ${config.type} grid only needs a stop below the range`);
  if (config.stopLossLow && config.type === "short")
    errors.push("a short grid only needs a stop above the range");

  let p: GridPlan;
  try {
    p = planGrid({
      config,
      symbol: env.symbol,
      market: env.market,
      price: reference,
      makerFee: env.makerFee,
      builderFee: env.builderFee,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, errors, warnings, summary };
  }

  const q = toDecimal(p.quantity);
  const symbol = env.symbol;
  const lowest = toDecimal(p.lines[0]!);
  const highest = toDecimal(p.lines[p.lines.length - 1]!);
  if (q.lt(symbol.minQuantity) || q.isZero()) {
    errors.push(
      `order size ${p.quantity} is below the minimum ${symbol.minQuantity}: use fewer grids or a bigger investment`,
    );
  } else if (q.mul(lowest).lt(symbol.minNotional)) {
    errors.push(
      `orders are worth ${q.mul(lowest).toFixed(2)} USDC at the lowest line, below SoDEX's minimum ${symbol.minNotional}: use fewer grids or a bigger investment`,
    );
  } else if (isSpotMarket && p.lines.length > 1) {
    // Spot sells are a little smaller than buys: SoDEX takes the buy's fee in the coin.
    const sellQ = toDecimal(roundQuantity(symbol, q.mul(1 - SPOT_FEE_ALLOWANCE), "down"));
    const lowestSell = toDecimal(p.lines[1]!);
    if (sellQ.lt(symbol.minQuantity) || sellQ.mul(lowestSell).lt(symbol.minNotional)) {
      errors.push(
        `after SoDEX's fee (taken in the coin) sells are worth ${sellQ.mul(lowestSell).toFixed(2)} USDC, below SoDEX's minimum ${symbol.minNotional}: use fewer grids or a bigger investment`,
      );
    }
  }
  if (!toDecimal(symbol.maxNotional).isZero() && q.mul(highest).gt(symbol.maxNotional))
    errors.push(`orders exceed SoDEX's max notional ${symbol.maxNotional}`);

  // Fees.
  if (!toDecimal(p.netPct).gt(0)) {
    errors.push(
      `the gap between lines (${toDecimal(p.grossPct).toFixed(3)}%) doesn't cover fees (${toDecimal(p.costPct).toFixed(3)}%): use fewer grids or a wider range`,
    );
  } else if (toDecimal(p.netPct).lt(toDecimal(p.costPct).mul(2))) {
    warnings.push(
      `profit per grid after fees is thin (${toDecimal(p.netPct).toFixed(3)}%); consider fewer grids`,
    );
  }

  // Leverage and liquidation (perps).
  if (!isSpotMarket) {
    const perps = symbol as { maxLeverage?: number };
    const cap = Math.min(10, perps.maxLeverage ?? 10, p.tierMaxLeverage ?? 10);
    if (config.leverage > cap)
      errors.push(
        `leverage ${config.leverage}x is above the allowed ${cap}x for this market and size`,
      );
    if (env.risk.maxLeverage !== undefined && config.leverage > env.risk.maxLeverage) {
      errors.push(
        `leverage ${config.leverage}x is above risk.maxLeverage ${env.risk.maxLeverage}x`,
      );
    }
    const longGuard = toDecimal(config.stopLossLow ?? config.lower).mul(1 - LIQUIDATION_BUFFER);
    const shortGuard = toDecimal(config.stopLossHigh ?? config.upper).mul(1 + LIQUIDATION_BUFFER);
    if (p.long.liquidation && toDecimal(p.long.liquidation).gt(longGuard)) {
      errors.push(
        `estimated liquidation of the long side (${toDecimal(p.long.liquidation).toFixed(2)}) is within 5% of ${config.stopLossLow ? "the stop-loss" : "the range"}: lower the leverage`,
      );
    }
    if (p.short.liquidation && toDecimal(p.short.liquidation).lt(shortGuard)) {
      errors.push(
        `estimated liquidation of the short side (${toDecimal(p.short.liquidation).toFixed(2)}) is within 5% of ${config.stopLossHigh ? "the stop-loss" : "the range"}: lower the leverage`,
      );
    }
    if (!config.stopLossLow && !config.stopLossHigh)
      warnings.push(
        "no stop-loss set: a strong trend out of the range has no exchange-side protection",
      );
  } else if (!config.stopLossLow) {
    warnings.push(
      "no stop-loss set: if the price falls through the range the bot keeps holding the coin",
    );
  }

  // The bot's own risk limits.
  const worstNotional = toDecimal(p.long.notional).gt(p.short.notional)
    ? p.long.notional
    : p.short.notional;
  const worstSize = toDecimal(p.long.size).gt(p.short.size) ? p.long.size : p.short.size;
  if (env.risk.maxNotional !== undefined && toDecimal(worstNotional).gt(env.risk.maxNotional)) {
    errors.push(
      `worst-case exposure ${toDecimal(worstNotional).toFixed(2)} USDC is above risk.maxNotional ${env.risk.maxNotional}: the far lines would never be placed`,
    );
  }
  if (env.risk.maxPosition !== undefined && toDecimal(worstSize).gt(env.risk.maxPosition)) {
    errors.push(
      `worst-case position ${worstSize} is above risk.maxPosition ${env.risk.maxPosition}`,
    );
  }
  const windowOrders =
    Math.min(config.window, p.buys.length) +
    Math.min(config.window, p.sells.length) +
    (isSpotMarket ? 0 : 1);
  if (env.risk.maxOpenOrders !== undefined && windowOrders > env.risk.maxOpenOrders) {
    errors.push(
      `the grid keeps up to ${windowOrders} orders open (window ${config.window} per side + stop) but risk.maxOpenOrders is ${env.risk.maxOpenOrders}`,
    );
  }
  if (env.availableQuote !== undefined && toDecimal(config.investment).gt(env.availableQuote)) {
    errors.push(
      `investment ${config.investment} USDC is more than the ${toDecimal(env.availableQuote).toFixed(2)} USDC free in your SoDEX ${isSpotMarket ? "spot" : "perps"} account (other bots' positions and orders use some): lower the investment, or stop a bot or deposit more`,
    );
  }

  // Summary.
  const typeLabel = { neutral: "Neutral", long: "Long", short: "Short", spot: "Spot" }[config.type];
  summary.push(
    `${typeLabel} grid ${config.lower} – ${config.upper}, ${config.grids} grids (${config.spacing}), ${config.investment} USDC${isSpotMarket ? "" : ` at ${config.leverage}x cross`}`,
    `${config.triggerPrice ? `starts when price reaches ${config.triggerPrice}` : `price ${env.markPrice}`} → ${p.buys.length} buys, ${p.sells.length} sells, gap line ${p.lines[p.gap]}, ${p.quantity} ${symbol.name.split(/[-_]/)[0]} per order`,
  );
  if (p.start) summary.push(`opens with a ${p.start.side} of ${p.start.quantity} at market first`);
  summary.push(
    `per grid: gross ${toDecimal(p.grossPerGrid).toFixed(4)} (${toDecimal(p.grossPct).toFixed(3)}%), fees ${toDecimal(p.feesPerGrid).toFixed(4)}, net ${toDecimal(p.netPerGrid).toFixed(4)} USDC`,
  );
  if (!toDecimal(p.long.size).isZero()) {
    summary.push(
      `worst long: ${p.long.size} @ avg ${toDecimal(p.long.avgEntry).toFixed(2)} (${toDecimal(p.long.notional).toFixed(2)} USDC)${p.long.liquidation ? `, est. liquidation ${toDecimal(p.long.liquidation).toFixed(2)}` : ""}`,
    );
  }
  if (!toDecimal(p.short.size).isZero()) {
    summary.push(
      `worst short: ${p.short.size} @ avg ${toDecimal(p.short.avgEntry).toFixed(2)} (${toDecimal(p.short.notional).toFixed(2)} USDC)${p.short.liquidation ? `, est. liquidation ${toDecimal(p.short.liquidation).toFixed(2)}` : ""}`,
    );
  }
  if (!isSpotMarket)
    summary.push(
      `effective leverage at the worst point: ${toDecimal(p.effectiveLeverage).toFixed(2)}x`,
    );
  const stops = [
    config.stopLossLow && `below at ${config.stopLossLow}`,
    config.stopLossHigh && `above at ${config.stopLossHigh}`,
  ].filter(Boolean);
  summary.push(
    `stop-loss: ${stops.length ? stops.join(", ") : "none"}${config.takeProfitPct ? `; take profit at +${config.takeProfitPct}%` : ""}; on stop: ${config.onStop.replace(/_/g, " ")}`,
  );
  summary.push(
    `lines: ${p.lines.map((l, i) => `${l}${i === p.gap ? "·" : p.buys.includes(i) ? "B" : "S"}`).join(" ")}`,
  );

  return { ok: errors.length === 0, errors, warnings, summary };
}

export const grid: Strategy<GridConfig, GridState> = {
  name: "grid",
  idPrefix: "g",
  parseConfig: parseGridConfig,
  validate,

  initialState: () => ({
    phase: "waiting",
    slots: [],
    owed: {},
    pairedWith: {},
    roundTrips: 0,
    gridProfit: "0",
  }),

  setup(ctx) {
    if (ctx.market !== "perps") return {};
    // Cross: USDC and every collateral coin in the perps account back the position.
    return { leverage: ctx.config.leverage, marginMode: "CROSS" };
  },

  onMarket(ctx, state) {
    const mark = ctx.mark();
    if (mark === undefined || state.phase === "done") return;
    const config = ctx.config;

    if (state.phase === "waiting") {
      if (config.triggerPrice) {
        state.triggerDirection ??= toDecimal(mark).gt(config.triggerPrice) ? "down" : "up";
        const hit =
          state.triggerDirection === "down"
            ? toDecimal(mark).lte(config.triggerPrice)
            : toDecimal(mark).gte(config.triggerPrice);
        if (!hit) return;
        ctx.log("info", `Trigger price ${config.triggerPrice} reached`);
      }
      // Lay out only once the price is inside the range; until then, wait.
      const outside = !toDecimal(mark).gt(config.lower) || !toDecimal(mark).lt(config.upper);
      if (outside) {
        if (!state.waitingForRange) {
          state.waitingForRange = true;
          ctx.log(
            "info",
            `Price ${canonicalDecimal(mark)} is outside ${config.lower}–${config.upper}; waiting for it to enter the range`,
          );
        }
        return;
      }
      state.waitingForRange = undefined;
      layOut(ctx, state, canonicalDecimal(mark));
      return;
    }

    if (state.layoutKey !== layoutKeyOf(config) && !state.layoutWarned) {
      state.layoutWarned = true;
      ctx.log(
        "warn",
        "Grid settings changed while running; the bot keeps its current lines. Stop it and start a new one to apply them.",
      );
    }

    // Bot-side stop-loss and take-profit.
    if (config.stopLossLow && toDecimal(mark).lte(config.stopLossLow)) {
      stopWith(
        ctx,
        state,
        `price ${canonicalDecimal(mark)} reached the stop-loss ${config.stopLossLow}`,
      );
      return;
    }
    if (config.stopLossHigh && toDecimal(mark).gte(config.stopLossHigh)) {
      stopWith(
        ctx,
        state,
        `price ${canonicalDecimal(mark)} reached the stop-loss ${config.stopLossHigh}`,
      );
      return;
    }
    if (config.takeProfitPct !== undefined) {
      const target = toDecimal(config.investment).mul(config.takeProfitPct).div(100);
      if (toDecimal(ctx.totalPnl()).gte(target)) {
        stopWith(
          ctx,
          state,
          `take profit reached (PnL ${toDecimal(ctx.totalPnl()).toFixed(2)} ≥ ${target.toFixed(2)})`,
        );
        return;
      }
    }

    const outside = toDecimal(mark).lt(config.lower)
      ? "below"
      : toDecimal(mark).gt(config.upper)
        ? "above"
        : undefined;
    if (outside !== state.outOfRange) {
      // The price often flickers across the edge; say it once per half hour, not on every crossing.
      if (ctx.now() - (state.rangeNoticeAt ?? 0) > 30 * 60_000) {
        state.rangeNoticeAt = ctx.now();
        ctx.log(
          outside ? "warn" : "info",
          outside
            ? `Price ${canonicalDecimal(mark)} is ${outside} the range; waiting`
            : `Price ${canonicalDecimal(mark)} is back inside the range`,
        );
      }
      state.outOfRange = outside;
    }
  },

  desired(ctx, state): DesiredOrder[] {
    const mark = ctx.mark();
    if (mark === undefined || !state.lines || !state.quantity) return [];

    if (state.phase === "opening" && state.start) {
      const s = state.start;
      const remaining = toDecimal(s.quantity).minus(s.filled);
      if (remaining.lte(0)) return [];
      s.price ??= roundPrice(
        ctx.symbol,
        toDecimal(mark).mul(1 + (s.side === "BUY" ? START_SLIPPAGE : -START_SLIPPAGE)),
        s.side === "BUY" ? "up" : "down",
      );
      return [
        {
          key: "start",
          side: s.side,
          kind: "limit",
          price: s.price,
          quantity: canonicalDecimal(remaining),
          ioc: true,
          postOnly: false,
        },
      ];
    }
    if (state.phase !== "running") return [];

    const orders: DesiredOrder[] = [];
    // Exchange-side stop-loss for whichever side the position is on (SoDEX needs an open
    // position for it). First in the list: at the open-order limit the engine drops the last.
    if (ctx.market === "perps") {
      const position = toDecimal(ctx.position());
      if (position.gt(0) && ctx.config.stopLossLow) {
        orders.push({
          key: "sl-low",
          side: "SELL",
          kind: "stop",
          stopPrice: ctx.config.stopLossLow,
          stopType: "STOP_LOSS",
          reduceOnly: true,
        });
      }
      if (position.lt(0) && ctx.config.stopLossHigh) {
        orders.push({
          key: "sl-high",
          side: "BUY",
          kind: "stop",
          stopPrice: ctx.config.stopLossHigh,
          stopType: "STOP_LOSS",
          reduceOnly: true,
        });
      }
    }

    const center = nearestLine(state.lines, mark);
    state.slots.forEach((side, i) => {
      if (!side || Math.abs(i - center) > ctx.config.window) return;
      const quantity = side === "SELL" ? (state.sellQty?.[i] ?? state.quantity!) : state.quantity!;
      if (!toDecimal(quantity).gt(0)) return;
      orders.push({
        key: lineKey(i),
        side,
        kind: "limit",
        price: state.lines![i]!,
        quantity,
        postOnly: true,
        onPostOnlyReject: "taker",
      });
    });
    return orders;
  },

  onFill(ctx, state, fill, order) {
    if (order.key === "start" && state.start) {
      state.start.filled = canonicalDecimal(toDecimal(state.start.filled).plus(fill.quantity));
      if (toDecimal(state.start.filled).gte(state.start.quantity)) {
        state.phase = "running";
        fundSells(ctx, state);
        ctx.log(
          "info",
          `Starting position ${state.start.side} ${state.start.filled} opened; placing the grid`,
        );
      }
      return;
    }
    if (order.key.startsWith("sl-")) {
      stopWith(ctx, state, `exchange stop-loss triggered at ${fill.price}`);
      return;
    }

    const i = lineIndex(order.key);
    if (i === undefined || !state.lines || order.status !== "filled") return; // partial fills wait for the rest
    const side = order.side;
    if (state.slots[i] === side) state.slots[i] = null;
    if (side === "SELL") delete state.sellQty?.[i];

    // A round trip completes only when this fill closed inventory opened one line
    // away. (Every grid fill is some order's counter order; a counter that re-opens
    // a position after a close is not a round trip.) The engine applies the fill to
    // the position before calling us, so position() is already "after".
    const after = toDecimal(ctx.position());
    const before = after.minus(side === "BUY" ? fill.quantity : toDecimal(fill.quantity).neg());
    const closing = after.abs().lt(before.abs());
    const from = state.pairedWith[i];
    if (closing && from !== undefined) {
      state.roundTrips += 1;
      const gain = toDecimal(state.lines[i]!).minus(state.lines[from]!).abs().mul(order.filledQty);
      state.gridProfit = canonicalDecimal(toDecimal(state.gridProfit).plus(gain));
    }
    delete state.pairedWith[i];

    const target = side === "BUY" ? i + 1 : i - 1;
    if (target >= 0 && target < state.lines.length) {
      if (state.slots[target] === null) assign(ctx, state, target, opposite(side), i);
      else state.owed[target] = { side: opposite(side), from: i }; // fill events arrived out of order
    }

    const owed = state.owed[i];
    if (owed && state.slots[i] === null) {
      assign(ctx, state, i, owed.side, owed.from);
      delete state.owed[i];
    }
  },

  onOrderClosed(ctx, state, order) {
    if (order.key !== "start" || !state.start || state.phase !== "opening") return;
    const s = state.start;
    s.attempts += 1;
    s.price = undefined; // re-price the next attempt
    if (s.attempts < MAX_START_ATTEMPTS) return;
    if (toDecimal(s.filled).gt(0)) {
      ctx.log(
        "warn",
        `Only ${s.filled} of the ${s.quantity} starting position filled after ${s.attempts} tries; continuing with what filled`,
      );
      state.phase = "running";
      fundSells(ctx, state);
    } else {
      stopWith(ctx, state, `could not open the starting position after ${s.attempts} tries`);
    }
  },

  describe(config, state) {
    const lines = [
      `grid ${config.type} ${config.lower}–${config.upper}, ${config.grids} grids, ${state.quantity ?? "?"} per order${phaseNote(state)}`,
      `round trips ${state.roundTrips}, grid profit ${toDecimal(state.gridProfit).toFixed(4)} USDC (before fees)`,
    ];
    if (state.start && state.phase === "opening")
      lines.push(`opening position: ${state.start.filled} / ${state.start.quantity}`);
    return lines;
  },

  sample(state) {
    return { gridProfit: Number(state.gridProfit), roundTrips: state.roundTrips };
  },
};
