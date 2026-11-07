import type { GridState } from "@sodextra/strategies";

import type { GridView } from "./types.ts";

const num = (value: string | undefined): number | null =>
  value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/**
 * The dashboard's Grid panel, from the strategy state the bot keeps in its KV "strategy"
 * (packages/strategies/src/grid/grid.ts). A bot that hasn't saved one yet shows as waiting.
 */
export function gridView(state: GridState | undefined): GridView {
  const start = state?.start;
  return {
    phase: state?.phase ?? "waiting",
    lines: (state?.lines ?? []).map((l) => num(l) ?? 0),
    slots: (state?.slots ?? []).map((s) => (s === "BUY" || s === "SELL" ? s : null)),
    quantity: num(state?.quantity),
    roundTrips: state?.roundTrips ?? 0,
    gridProfit: num(state?.gridProfit) ?? 0,
    outOfRange: state?.outOfRange ?? null,
    waitingForRange: state?.waitingForRange === true,
    start: start
      ? { side: start.side, quantity: num(start.quantity) ?? 0, filled: num(start.filled) ?? 0 }
      : null,
  };
}
