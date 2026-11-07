/**
 * A bot's profit over time for the dashboard chart, from the minute PnL samples its engine
 * keeps (engine.ts #sample): total PnL after fees, and a Grid bot's grid profit.
 */
import type { BotRecord, SqliteStore } from "@sodextra/engine-core";

import type { ProfitPeriod, ProfitView } from "./types.ts";

export const PROFIT_PERIODS: readonly ProfitPeriod[] = ["run", "day", "week", "all"];
const SPAN_MS: Partial<Record<ProfitPeriod, number>> = { day: 86_400_000, week: 7 * 86_400_000 };
/** A chart needs no more points than this; longer windows keep each bucket's last sample. */
const MAX_POINTS = 240;

/**
 * Samples since the period began. "all" shows the bot's totals; the other periods count
 * from their first sample, so each curve starts at zero (what the period made).
 */
export function profitView(
  store: SqliteStore,
  bot: BotRecord,
  period: ProfitPeriod,
  now = Date.now(),
): ProfitView {
  const runStart = store.listSessions(bot.id, 1)[0]?.startedAt ?? bot.createdAt;
  const from =
    period === "run"
      ? Math.floor(runStart / 60_000) * 60_000
      : period === "all"
        ? 0
        : now - SPAN_MS[period]!;
  const rows = store.listSamples(bot.id, from);
  const first = rows[0];
  if (!first) return { period, from, points: [] };

  const span = Math.max(1, rows.at(-1)!.at - first.at);
  const bucket = Math.max(60_000, Math.ceil(span / MAX_POINTS / 60_000) * 60_000);
  const kept = rows.filter(
    (r, i) =>
      i === rows.length - 1 || Math.floor(r.at / bucket) !== Math.floor(rows[i + 1]!.at / bucket),
  );
  const base =
    period === "all"
      ? { pnl: 0, grid: 0, trips: 0 }
      : {
          pnl: first.pnl,
          grid: first.data.gridProfit ?? 0,
          trips: first.data.roundTrips ?? 0,
        };
  return {
    period,
    from: period === "all" ? first.at : from,
    points: [first, ...kept.filter((r) => r !== first)].map((r) => ({
      at: r.at,
      pnl: r.pnl - base.pnl,
      gridProfit: (r.data.gridProfit ?? 0) - base.grid,
      roundTrips: (r.data.roundTrips ?? 0) - base.trips,
    })),
  };
}
