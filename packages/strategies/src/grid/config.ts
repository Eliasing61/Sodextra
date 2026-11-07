import { canonicalDecimal, toDecimal } from "@sodextra/sodex-client";

/**
 * neutral: start flat; buys below fill into a long, sells above into a short.
 * long:    start long (the size the sells above will close); good for an upward-biased range.
 * short:   mirror of long.
 * spot:    like long, without leverage: buys the coin for the sells above at the start.
 */
export type GridType = "neutral" | "long" | "short" | "spot";

export interface GridConfig {
  type: GridType;
  lower: string;
  upper: string;
  /** N grids = N + 1 price lines. */
  grids: number;
  spacing: "arithmetic" | "geometric";
  /** USDC margin (perps) or capital (spot). */
  investment: string;
  /** Perps only, cross margin (any collateral the account holds backs it). */
  leverage: number;
  /** Stop-loss below the range: protects a long position. */
  stopLossLow?: string | undefined;
  /** Stop-loss above the range: protects a short position. */
  stopLossHigh?: string | undefined;
  /** Stop once total PnL reaches this % of the investment. */
  takeProfitPct?: number | undefined;
  /** Wait until the price reaches this before starting. */
  triggerPrice?: string | undefined;
  /** What strategy-initiated stops (stop-loss, take-profit) do with the position. */
  onStop: "cancel_only" | "cancel_and_close";
  /** Live orders per side around the price (default min(N, 20)). */
  window: number;
}

export const MAX_GRIDS = 100;
export const MAX_LEVERAGE = 10;
export const DEFAULT_WINDOW = 20;

function decimal(r: Record<string, unknown>, key: string, required: true): string;
function decimal(r: Record<string, unknown>, key: string, required: false): string | undefined;
function decimal(r: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = r[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`grid: "${key}" is required`);
    return undefined;
  }
  let d;
  try {
    d = toDecimal(String(value));
  } catch {
    throw new Error(`grid: "${key}" must be a number`);
  }
  if (!d.gt(0)) throw new Error(`grid: "${key}" must be greater than 0`);
  return canonicalDecimal(d);
}

/** Structural parsing only; market-dependent checks happen in validate(). */
export function parseGridConfig(raw: unknown): GridConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = (r.type ?? "neutral") as GridType;
  if (!["neutral", "long", "short", "spot"].includes(type)) {
    throw new Error('grid: "type" must be "neutral", "long", "short" or "spot"');
  }

  const lower = decimal(r, "lower", true);
  const upper = decimal(r, "upper", true);
  if (!toDecimal(upper).gt(lower)) throw new Error('grid: "upper" must be above "lower"');

  const grids = Number(r.grids);
  if (!Number.isInteger(grids) || grids < 2 || grids > MAX_GRIDS) {
    throw new Error(`grid: "grids" must be a whole number from 2 to ${MAX_GRIDS}`);
  }

  const spacing =
    r.spacing === undefined
      ? toDecimal(upper).div(lower).gt(1.5)
        ? "geometric"
        : "arithmetic"
      : r.spacing;
  if (spacing !== "arithmetic" && spacing !== "geometric") {
    throw new Error('grid: "spacing" must be "arithmetic" or "geometric"');
  }

  const leverage = r.leverage === undefined ? 3 : Number(r.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) {
    throw new Error(`grid: "leverage" must be a whole number from 1 to ${MAX_LEVERAGE}`);
  }

  // Older bot files carry "marginMode": perps bots now always run cross, so it's ignored.

  const onStop = r.onStop ?? "cancel_and_close";
  if (onStop !== "cancel_only" && onStop !== "cancel_and_close") {
    throw new Error('grid: "onStop" must be "cancel_only" or "cancel_and_close"');
  }

  // "stopLoss" is a convenience: it goes below the range for long/spot, above for
  // short, and for neutral to whichever side of the range it lies on.
  let stopLossLow = decimal(r, "stopLossLow", false);
  let stopLossHigh = decimal(r, "stopLossHigh", false);
  const stopLoss = decimal(r, "stopLoss", false);
  if (stopLoss !== undefined) {
    const below =
      type === "long" || type === "spot"
        ? true
        : type === "short"
          ? false
          : toDecimal(stopLoss).lt(lower);
    if (below) stopLossLow ??= stopLoss;
    else stopLossHigh ??= stopLoss;
  }

  const takeProfitPct = r.takeProfitPct === undefined ? undefined : Number(r.takeProfitPct);
  if (takeProfitPct !== undefined && !(takeProfitPct > 0)) {
    throw new Error('grid: "takeProfitPct" must be greater than 0');
  }

  const window = r.window === undefined ? Math.min(grids, DEFAULT_WINDOW) : Number(r.window);
  if (!Number.isInteger(window) || window < 1 || window > 50) {
    throw new Error('grid: "window" must be a whole number from 1 to 50');
  }

  return {
    type,
    lower,
    upper,
    grids,
    spacing,
    investment: decimal(r, "investment", true),
    leverage: type === "spot" ? 1 : leverage,
    stopLossLow,
    stopLossHigh,
    takeProfitPct,
    triggerPrice: decimal(r, "triggerPrice", false),
    onStop,
    window,
  };
}
