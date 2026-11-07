import { Decimal } from "decimal.js";

import {
  canonicalDecimal,
  roundToIncrement,
  toDecimal,
  type MarketSymbol,
  type PerpsSymbol,
} from "@sodextra/sodex-client";

import type { GridConfig } from "./config.ts";

const MIN_GAP_TICKS = 5;
/** Perps: size so the worst side uses at most 90% of investment × leverage. */
const PERPS_HEADROOM = 0.9;
/** Spot: keep 2% of the capital for fees. */
const SPOT_HEADROOM = 0.98;
/** Liquidation must sit at least this far beyond the stop (or the range edge). */
const LIQUIDATION_BUFFER = 0.05;

/** Price lines, ascending, rounded to the tick. Returns problems if lines merge or sit too close. */
export function buildLines(
  config: Pick<GridConfig, "lower" | "upper" | "grids" | "spacing">,
  symbol: MarketSymbol,
) {
  const lower = toDecimal(config.lower);
  const upper = toDecimal(config.upper);
  const n = config.grids;
  const lines: string[] = [];
  for (let i = 0; i <= n; i++) {
    const raw =
      config.spacing === "arithmetic"
        ? lower.plus(upper.minus(lower).mul(i).div(n))
        : lower.mul(upper.div(lower).pow(new Decimal(i).div(n)));
    lines.push(roundToIncrement(raw, symbol.tickSize, "nearest"));
  }
  const problems: string[] = [];
  const minGap = toDecimal(symbol.tickSize).mul(MIN_GAP_TICKS);
  for (let i = 1; i <= n; i++) {
    if (
      toDecimal(lines[i]!)
        .minus(lines[i - 1]!)
        .lt(minGap)
    ) {
      problems.push(
        `lines ${lines[i - 1]} and ${lines[i]} are closer than ${MIN_GAP_TICKS} ticks after rounding; use fewer grids or a wider range`,
      );
      break;
    }
  }
  return { lines, problems };
}

/** Index of the line nearest to `price` (the empty "gap" line). */
export function nearestLine(lines: string[], price: string): number {
  const p = toDecimal(price);
  let best = 0;
  for (let i = 1; i < lines.length; i++) {
    if (toDecimal(lines[i]!).minus(p).abs().lt(toDecimal(lines[best]!).minus(p).abs())) best = i;
  }
  return best;
}

export interface SideRisk {
  /** Position size if every order on this side filled (base coin). */
  size: string;
  avgEntry: string;
  /** size × avgEntry. */
  notional: string;
  /** Estimated liquidation price at that worst point (perps); undefined when flat or not liquidatable. */
  liquidation?: string | undefined;
}

export interface GridPlan {
  lines: string[];
  gap: number;
  buys: number[];
  sells: number[];
  quantity: string;
  start?: { side: "BUY" | "SELL"; quantity: string } | undefined;
  /** Smallest gross profit per grid, % of notional and USDC at `quantity`. */
  grossPct: string;
  grossPerGrid: string;
  /** Maker fees for one buy + sell, % and USDC. */
  costPct: string;
  feesPerGrid: string;
  netPct: string;
  netPerGrid: string;
  long: SideRisk;
  short: SideRisk;
  /** Worst side's notional ÷ investment. */
  effectiveLeverage: string;
  /** Max leverage allowed by the margin tier of the worst notional (perps). */
  tierMaxLeverage?: number | undefined;
}

export interface PlanInput {
  config: GridConfig;
  symbol: MarketSymbol;
  market: "perps" | "spot";
  price: string;
  makerFee: string;
  builderFee: string;
}

/**
 * Lay out the grid at `price`: which lines hold buys and sells, the order size,
 * profit per grid after fees, and the worst case on each side. Pure; throws only
 * on structural problems (price outside the range, lines merging).
 */
export function planGrid(input: PlanInput): GridPlan {
  const { config, symbol, market } = input;
  const { lines, problems } = buildLines(config, symbol);
  if (problems.length > 0) throw new Error(problems[0]);

  const price = toDecimal(input.price);
  if (price.lte(config.lower) || price.gte(config.upper)) {
    throw new Error(`price ${input.price} is outside the range ${config.lower}–${config.upper}`);
  }

  const gap = nearestLine(lines, input.price);
  const buys = lines.map((_, i) => i).filter((i) => i < gap);
  const sells = lines.map((_, i) => i).filter((i) => i > gap);
  const sum = (idx: number[]) => idx.reduce((s, i) => s.plus(lines[i]!), new Decimal(0));
  const B = buys.length;
  const S = sells.length;

  // Order size, the same for every line. It must be safe wherever the price is
  // when the grid lays out (it waits for the price to enter the range, which can
  // be right at an edge), so the capacity is spread over all N lines: even if
  // every line ends up on one side, that side's notional stays within capacity.
  // At most N orders' worth can ever be on one side, each worth ≤ its line price,
  // and the top N lines are the most expensive N.
  const topLines = lines.slice(1).reduce((s, l) => s.plus(l), new Decimal(0));
  const capacity =
    market === "spot" || config.type === "spot"
      ? toDecimal(config.investment).mul(SPOT_HEADROOM)
      : toDecimal(config.investment).mul(config.leverage).mul(PERPS_HEADROOM);
  const raw = capacity.div(topLines);
  const quantity = roundToIncrement(raw, symbol.stepSize, "down");
  const q = toDecimal(quantity);

  const startLong = config.type === "long" || config.type === "spot" ? S : 0;
  const startShort = config.type === "short" ? B : 0;
  const start =
    startLong > 0
      ? { side: "BUY" as const, quantity: canonicalDecimal(q.mul(startLong)) }
      : startShort > 0
        ? { side: "SELL" as const, quantity: canonicalDecimal(q.mul(startShort)) }
        : undefined;

  // Profit per grid: the tightest gap in % terms decides.
  let minGrossPct = new Decimal(Infinity);
  let minGross = new Decimal(Infinity);
  let fees = new Decimal(0);
  for (let i = 0; i < lines.length - 1; i++) {
    const lo = toDecimal(lines[i]!);
    const hi = toDecimal(lines[i + 1]!);
    const pct = hi.minus(lo).div(hi);
    if (pct.lt(minGrossPct)) {
      minGrossPct = pct;
      minGross = hi.minus(lo).mul(q);
      fees = lo
        .plus(hi)
        .mul(q)
        .mul(input.makerFee)
        .plus(
          lo
            .plus(hi)
            .mul(q)
            .mul(input.builderFee)
            .div(market === "spot" ? 2 : 1),
        );
    }
  }
  const builderSides = market === "spot" ? 1 : 2;
  const costPct = toDecimal(input.makerFee)
    .mul(2)
    .plus(toDecimal(input.builderFee).mul(builderSides));

  // Worst case on each side.
  const side = (count: number, linePrices: Decimal, startCount: number): SideRisk => {
    const size = q.mul(count + startCount);
    if (size.isZero()) return { size: "0", avgEntry: "0", notional: "0" };
    const notional = q.mul(linePrices).plus(q.mul(startCount).mul(price));
    return {
      size: canonicalDecimal(size),
      avgEntry: canonicalDecimal(notional.div(size)),
      notional: canonicalDecimal(notional),
    };
  };
  const long = config.type === "short" ? side(0, new Decimal(0), 0) : side(B, sum(buys), startLong);
  const short =
    config.type === "long" || config.type === "spot"
      ? side(0, new Decimal(0), 0)
      : side(S, sum(sells), startShort);

  let tierMaxLeverage: number | undefined;
  if (market === "perps") {
    const perps = symbol as PerpsSymbol;
    const margin = (r: SideRisk) =>
      Decimal.min(toDecimal(config.investment), toDecimal(r.notional).div(config.leverage));
    if (!toDecimal(long.size).isZero())
      long.liquidation = liquidationPrice("long", long, margin(long), perps);
    if (!toDecimal(short.size).isZero())
      short.liquidation = liquidationPrice("short", short, margin(short), perps);
    const worst = Decimal.max(long.notional, short.notional);
    tierMaxLeverage = tierFor(perps, worst)?.maxLeverage ?? perps.maxLeverage;
  }

  const worstNotional = Decimal.max(
    toDecimal(long.size).mul(config.lower),
    toDecimal(short.size).mul(config.upper),
  );

  return {
    lines,
    gap,
    buys,
    sells,
    quantity,
    start,
    grossPct: canonicalDecimal(minGrossPct.mul(100)),
    grossPerGrid: canonicalDecimal(minGross),
    costPct: canonicalDecimal(costPct.mul(100)),
    feesPerGrid: canonicalDecimal(fees),
    netPct: canonicalDecimal(minGrossPct.minus(costPct).mul(100)),
    netPerGrid: canonicalDecimal(minGross.minus(fees)),
    long,
    short,
    effectiveLeverage: canonicalDecimal(worstNotional.div(config.investment)),
    tierMaxLeverage,
  };
}

function tierFor(symbol: PerpsSymbol, notional: Decimal.Value) {
  return symbol.marginTiers.find((t) => toDecimal(t.maxNotionalValue).gte(notional));
}

/**
 * Isolated-margin liquidation estimate:
 *   long:  margin + size·(P − entry) = size·P·mmr − deduction
 *   short: margin + size·(entry − P) = size·P·mmr − deduction
 * Margin is min(investment, notional ÷ leverage), the conservative reading of
 * isolated margin. Returns undefined if the position can't be liquidated.
 */
export function liquidationPrice(
  direction: "long" | "short",
  risk: Pick<SideRisk, "size" | "avgEntry" | "notional">,
  margin: Decimal.Value,
  symbol: PerpsSymbol,
): string | undefined {
  const tier = tierFor(symbol, risk.notional);
  const mmr = toDecimal(tier?.maintenanceMarginRate ?? new Decimal(1).div(2 * symbol.maxLeverage));
  const deduction = toDecimal(tier?.maintenanceDeduction ?? 0);
  const size = toDecimal(risk.size);
  const entry = toDecimal(risk.avgEntry);
  const m = toDecimal(String(margin));
  const p =
    direction === "long"
      ? size
          .mul(entry)
          .minus(m)
          .minus(deduction)
          .div(size.mul(new Decimal(1).minus(mmr)))
      : m
          .plus(size.mul(entry))
          .plus(deduction)
          .div(size.mul(new Decimal(1).plus(mmr)));
  return p.gt(0) ? canonicalDecimal(p.toDecimalPlaces(8)) : undefined;
}

export { LIQUIDATION_BUFFER };
