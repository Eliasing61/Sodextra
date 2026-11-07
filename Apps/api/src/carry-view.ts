import {
  totalPnl,
  type BotRecord,
  type Fill,
  type PositionState,
  type SqliteStore,
} from "@sodextra/engine-core";
import { toDecimal } from "@sodextra/sodex-client";

import type { CarryView } from "./types.ts";
import type { ViewContext } from "./views.ts";

const DAY = 86_400_000;

/** Funding Carry's per-leg bots, shown under their parent bot rather than on their own. */
export const CARRY_LEG = "carry-leg";

/** What the Funding Carry runner keeps in the parent bot's KV "carry". */
interface CarryRecord {
  state: {
    phase: CarryView["phase"];
    market?: string;
    next?: string;
    reason?: string;
    ema: Record<string, { bpH: number }>;
    moves: { at: number; from?: string; to?: string; reason: string }[];
  };
  funding: { total: number; byMarket: Record<string, number> };
  legs: Record<string, { perpBot: string; spotBot: string }>;
  ranked: CarryView["ranked"];
  scannedAt?: number;
  liqPrice?: number;
}

interface Leg {
  bot: BotRecord;
  position: PositionState | undefined;
  mark: string | undefined;
}

/** Every leg bot this carry bot has opened (all markets it has held). */
function legs(store: SqliteStore, record: CarryRecord | undefined, ctx: ViewContext): Leg[] {
  const out: Leg[] = [];
  for (const ids of Object.values(record?.legs ?? {})) {
    for (const id of [ids.perpBot, ids.spotBot]) {
      const bot = store.getBot(id);
      if (!bot) continue;
      out.push({
        bot,
        position: store.getKV<{ position: PositionState }>(id, "engine")?.position,
        mark: ctx.mark(bot),
      });
    }
  }
  return out;
}

const legPnl = (l: Leg) =>
  l.position
    ? Number(
        l.mark
          ? totalPnl(l.position, l.mark)
          : toDecimal(l.position.realizedPnl).minus(l.position.fees),
      )
    : 0;

/** Volume, fees, PnL and fills of a carry bot: both legs on every market, plus funding. */
export function carryTotals(store: SqliteStore, bot: BotRecord, ctx: ViewContext) {
  const record = store.getKV<CarryRecord>(bot.id, "carry");
  const all = legs(store, record, ctx);
  const fills: Fill[] = all
    .flatMap((l) => store.listFills(l.bot.id))
    .sort((a, b) => b.time - a.time);
  const notional = (f: Fill) => Number(f.price) * Number(f.quantity);
  const dayStart = Math.floor(ctx.now / DAY) * DAY;
  const legsPnl = all.reduce((s, l) => s + legPnl(l), 0);
  const funding = record?.funding.total ?? 0;
  return {
    record,
    legs: all,
    fills,
    volume: all.reduce((s, l) => s + Number(l.position?.volume ?? 0), 0),
    volumeToday: fills.filter((f) => f.time >= dayStart).reduce((s, f) => s + notional(f), 0),
    volume14d: fills
      .filter((f) => f.time >= ctx.now - 14 * DAY)
      .reduce((s, f) => s + notional(f), 0),
    fees: all.reduce((s, l) => s + Number(l.position?.fees ?? 0), 0),
    legsPnl,
    funding,
    pnl: legsPnl + funding,
  };
}

/** The dashboard's Carry panel. */
export function carryView(
  store: SqliteStore,
  bot: BotRecord,
  ctx: ViewContext,
  totals: ReturnType<typeof carryTotals>,
): CarryView {
  const config = (bot.config ?? {}) as Record<string, unknown>;
  const record = totals.record;
  const s = record?.state;
  const market = s && s.phase !== "idle" ? (s.market ?? null) : null;
  const ids = market ? record?.legs[market] : undefined;
  const side = (id: string | undefined) => {
    const leg = totals.legs.find((l) => l.bot.id === id);
    if (!leg) return null;
    const position = Number(leg.position?.size ?? 0);
    const mark = Number(leg.mark ?? leg.position?.avgEntry ?? 0);
    return { symbol: leg.bot.symbol, position, usd: position * mark };
  };
  const perp = side(ids?.perpBot);
  const spot = side(ids?.spotBot);
  const perpMark = perp && perp.position !== 0 ? Math.abs(perp.usd / perp.position) : null;
  const current = market ? record?.ranked.find((r) => r.market === market) : undefined;
  const liq = record?.liqPrice;
  return {
    phase: s?.phase ?? "idle",
    market,
    coin: current?.coin ?? market?.split("-")[0] ?? null,
    next: s?.next ?? null,
    reason: s?.reason ?? null,
    size: Number(config.size ?? 0),
    leverage: Number(config.leverage ?? 2),
    perp,
    spot,
    imbalanceUsd: Math.abs((perp?.usd ?? 0) + (spot?.usd ?? 0)),
    fundingNowBpH: current?.fundingBpH ?? null,
    fundingAvgBpH: market ? (s?.ema[market]?.bpH ?? null) : null,
    nextFundingAt: Math.floor(ctx.now / 3_600_000) * 3_600_000 + 3_600_000,
    fundingReceived: totals.funding,
    fundingByMarket: record?.funding.byMarket ?? {},
    legsPnl: totals.legsPnl,
    fees: totals.fees,
    liqDistancePct: liq && perpMark ? ((liq - perpMark) / perpMark) * 100 : null,
    ranked: (record?.ranked ?? []).slice(0, 8),
    scannedAt: record?.scannedAt ?? null,
    moves: (s?.moves ?? [])
      .slice(-10)
      .reverse()
      .map((m) => ({ at: m.at, from: m.from ?? null, to: m.to ?? null, reason: m.reason })),
  };
}
