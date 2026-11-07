import {
  emptyPosition,
  feeInBase,
  totalPnl,
  unrealizedPnl,
  type BotRecord,
  type EngineStats,
  type Fill,
  type PositionState,
  type SqliteStore,
} from "@sodextra/engine-core";
import { toDecimal } from "@sodextra/sodex-client";
import { STRATEGIES, type GridState } from "@sodextra/strategies";

import { carryTotals, carryView } from "./carry-view.ts";
import { fillHistory, fillRows, spotBase, type FillRow } from "./fill-history.ts";
import { gridView } from "./grid-view.ts";
import type {
  Bar,
  BotListItem,
  BotTypeStats,
  BotView,
  FillView,
  PeriodStats,
  SessionView,
} from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BARS = 24;

interface EngineKV {
  position: PositionState;
  stats?: EngineStats;
}

const n = (value: string | undefined): number => (value === undefined ? 0 : Number(value));

export interface ViewContext {
  now: number;
  /** Mark price by symbol, when known. */
  mark: (bot: BotRecord) => string | undefined;
  online: (botId: string) => boolean;
}

export function listItem(store: SqliteStore, bot: BotRecord, ctx: ViewContext): BotListItem {
  if (bot.strategy === "carry") {
    const t = carryTotals(store, bot, ctx);
    return {
      id: bot.id,
      name: bot.name,
      strategy: bot.strategy,
      symbol: t.record?.state.market ?? bot.symbol,
      market: bot.market,
      mode: bot.mode,
      status: bot.status,
      statusReason: bot.statusReason,
      online: ctx.online(bot.id),
      updatedAt: bot.updatedAt,
      volume: t.volume,
      volumeToday: t.volumeToday,
      pnl: t.pnl,
      costPerMillion: t.volume > 0 ? (-t.pnl / t.volume) * 1_000_000 : null,
      position: 0,
      run: null,
      today: null,
      lastEvent: lastEvent(store, bot.id),
      ...hiddenOf(store, bot.id),
    };
  }
  const engine = store.getKV<EngineKV>(bot.id, "engine");
  const mark = ctx.mark(bot);
  const p = engine?.position;
  const pnl = p ? Number(mark ? totalPnl(p, mark) : toDecimal(p.realizedPnl).minus(p.fees)) : null;
  const volume = n(p?.volume);
  const dayStart = Math.floor(ctx.now / DAY) * DAY;
  const { rows } = fillHistory(store, bot.id, spotBase(bot));
  const volumeToday = sumSince(rows, dayStart);
  const runStart = store.listSessions(bot.id, 1)[0]?.startedAt ?? bot.createdAt;
  const unrealised = p && mark ? Number(unrealizedPnl(p, mark)) : 0;
  const periods = periodsOf(rows, unrealised, { run: runStart, today: dayStart });
  return {
    id: bot.id,
    name: bot.name,
    strategy: bot.strategy,
    symbol: bot.symbol,
    market: bot.market,
    mode: bot.mode,
    status: bot.status,
    statusReason: bot.statusReason,
    online: ctx.online(bot.id),
    updatedAt: bot.updatedAt,
    volume,
    volumeToday,
    pnl,
    costPerMillion: pnl !== null && volume > 0 ? (-pnl / volume) * 1_000_000 : null,
    position: n(p?.size),
    run: periods.run,
    today: periods.today,
    lastEvent: lastEvent(store, bot.id),
    ...hiddenOf(store, bot.id),
  };
}

function lastEvent(store: SqliteStore, botId: string) {
  const e = store.recentEvents(botId, 1)[0];
  return e ? { at: e.time, level: e.level, message: e.message } : undefined;
}

/** Taken off the dashboard's list (POST /bots/:id/remove); only sent when it is. */
function hiddenOf(store: SqliteStore, botId: string): Pick<BotListItem, "hidden"> {
  return store.getKV<boolean>(botId, "hidden") === true ? { hidden: true } : {};
}

/**
 * Real results per bot type, from every live bot on this server: what the website shows
 * on each bot type card. The first Profit Maker (take-profit exits) was a different bot,
 * so its runs don't count toward today's.
 */
export function botTypeStats(store: SqliteStore, ctx: ViewContext): Record<string, BotTypeStats> {
  const out: Record<string, BotTypeStats> = {};
  for (const bot of store.listBots()) {
    if (bot.mode !== "live" || bot.strategy === "probe" || bot.strategy === "carry-leg") continue;
    const config = (bot.config ?? {}) as Record<string, unknown>;
    if (bot.strategy === "profit" && config.targetBps !== undefined) continue;
    const item = listItem(store, bot, ctx);
    const s = (out[bot.strategy] ??= { bots: 0, runs: 0, volume: 0, pnl: 0, bps: null });
    s.bots += 1;
    s.runs += store.listSessions(bot.id, 10_000).length;
    s.volume += item.volume;
    s.pnl += item.pnl ?? 0;
  }
  for (const s of Object.values(out)) s.bps = s.volume > 0 ? (s.pnl / s.volume) * 10_000 : null;
  return out;
}

/**
 * Sessions with the fills that happened during each. Realised PnL is replayed over
 * the bot's whole fill history, so a session that closes an older position gets
 * the right figure.
 */
export function sessionViews(
  store: SqliteStore,
  bots: BotRecord[],
  ctx: ViewContext,
  limit = 200,
): SessionView[] {
  const out: SessionView[] = [];
  for (const bot of bots) {
    const online = ctx.online(bot.id);
    const { fills, rows } = fillHistory(store, bot.id, spotBase(bot));
    const lastActivity = fills.at(-1)?.time;
    let sessions = store.listSessions(bot.id, limit);
    // Bots that traded before sessions were recorded get one summary run of that history.
    if (sessions.length === 0 && fills.length > 0) {
      sessions = [
        {
          id: -sessionKey(bot.id),
          botId: bot.id,
          startedAt: fills[0]!.time,
          endedAt: lastActivity,
          endReason: "recorded before session tracking",
        },
      ];
    }
    if (sessions.length === 0) continue;

    const views = sessions.map((s, i) => {
      const open = s.endedAt === undefined;
      const running = open && i === 0 && online;
      const end =
        s.endedAt ?? (running ? ctx.now : Math.max(lastActivity ?? s.startedAt, s.startedAt));
      return {
        view: {
          id: s.id,
          botId: bot.id,
          botName: bot.name,
          strategy: bot.strategy,
          symbol: bot.symbol,
          mode: bot.mode,
          startedAt: s.startedAt,
          endedAt: running ? null : end,
          running,
          endReason: running ? null : (s.endReason ?? "process ended"),
          volume: 0,
          fills: 0,
          makerShare: null as number | null,
          fees: 0,
          realisedNet: 0,
          costBps: null as number | null,
        } satisfies SessionView,
        end,
        maker: 0,
      };
    });

    for (const r of rows) {
      const hit = views.find((v) => r.time >= v.view.startedAt && r.time <= v.end);
      if (!hit) continue;
      hit.view.volume += r.notional;
      hit.view.fills += 1;
      if (r.maker) hit.maker += r.notional;
      hit.view.fees += r.fee;
      hit.view.realisedNet += r.realised;
    }
    for (const v of views) {
      if (v.view.volume > 0) {
        v.view.makerShare = v.maker / v.view.volume;
        v.view.costBps = (-v.view.realisedNet / v.view.volume) * 10_000;
      }
      out.push(v.view);
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export function botView(store: SqliteStore, bot: BotRecord, ctx: ViewContext): BotView {
  const view = baseView(store, bot, ctx);
  if (bot.strategy === "grid") view.grid = gridView(store.getKV<GridState>(bot.id, "strategy"));
  if (bot.strategy !== "carry") return view;
  // Funding Carry: the parent has no market of its own; its legs and funding make the numbers.
  const t = carryTotals(store, bot, ctx);
  view.symbol = t.record?.state.market ?? bot.symbol;
  view.metrics = {
    ...view.metrics,
    volumeToday: t.volumeToday,
    volume14d: t.volume14d,
    volumeTotal: t.volume,
    fees: t.fees,
    realised: t.legsPnl,
    pnl: t.pnl,
    costPerMillion: t.volume > 0 ? (-t.pnl / t.volume) * 1_000_000 : null,
    fills24h: t.fills.filter((f) => f.time >= ctx.now - DAY).length,
    fillsTotal: t.fills.length,
    position: 0,
    positionUsd: 0,
  };
  view.fills = t.fills.slice(0, 50).map((f) => fillView(f));
  view.carry = carryView(store, bot, ctx, t);
  return view;
}

function baseView(store: SqliteStore, bot: BotRecord, ctx: ViewContext): BotView {
  const { now } = ctx;
  const engine = store.getKV<EngineKV>(bot.id, "engine");
  const p = engine?.position ?? emptyPosition();
  const stats = engine?.stats;
  const markStr = ctx.mark(bot);
  const mark = markStr === undefined ? null : Number(markStr);

  // Oldest first, replayed once and kept between requests (fill-history.ts).
  const base = spotBase(bot);
  const { fills, rows } = fillHistory(store, bot.id, base);
  const volume = n(p.volume);
  const realised = n(p.realizedPnl);
  const fees = n(p.fees);
  const unrealised = markStr ? Number(unrealizedPnl(p, markStr)) : 0;
  const pnl = markStr ? Number(totalPnl(p, markStr)) : realised - fees;
  const position = n(p.size);

  const dayStart = Math.floor(now / DAY) * DAY;

  const budget = store.getKV<{ remaining: number } | null>(bot.id, "actionBudget");
  const sessionStart = store.listSessions(bot.id, 1)[0]?.startedAt ?? bot.createdAt;

  return {
    id: bot.id,
    name: bot.name,
    strategy: bot.strategy,
    symbol: bot.symbol,
    market: bot.market,
    mode: bot.mode,
    status: bot.status,
    statusReason: bot.statusReason,
    online: ctx.online(bot.id),
    startedAt: bot.createdAt,
    asOf: now,
    config: pickConfig(bot.config),
    risk: pickRisk(store.getKV<Record<string, unknown>>(bot.id, "risk")),
    metrics: {
      volumeToday: sumSince(rows, dayStart),
      volume14d: sumSince(rows, now - 14 * DAY),
      volumeTotal: volume,
      makerShare: stats && volume > 0 ? n(stats.makerVolume) / volume : null,
      fees,
      realised,
      unrealised,
      pnl,
      costPerMillion: volume > 0 ? (-pnl / volume) * 1_000_000 : null,
      actions: stats?.actions ?? 0,
      actionsPerDollar: stats && volume > 0 ? stats.actions / volume : null,
      actionBudget: budget?.remaining ?? null,
      fills24h: countSince(rows, now - DAY),
      fillsTotal: p.fillCount,
      position,
      positionUsd: position * (mark ?? n(p.avgEntry)),
      avgEntry: n(p.avgEntry),
      mark,
    },
    sessions: store.listSessions(bot.id, 20).map((s, i) => ({
      startedAt: s.startedAt,
      // An unclosed run is either the live one or a process that died: end it at its last trade.
      endedAt:
        s.endedAt ?? (i === 0 && ctx.online(bot.id) ? null : (fills.at(-1)?.time ?? s.startedAt)),
    })),
    periods: periodsOf(rows, unrealised, {
      session: sessionStart,
      today: dayStart,
      week: now - 7 * DAY,
      all: 0,
    }),
    orders: store.activeOrders(bot.id).map((o) => ({
      key: o.key,
      side: o.side,
      kind: o.kind,
      price: o.price === undefined ? null : Number(o.price),
      stopPrice: o.stopPrice === undefined ? null : Number(o.stopPrice),
      quantity: o.quantity === undefined ? null : Number(o.quantity),
      status: o.status,
      postOnly: o.postOnly === true,
    })),
    ...barsOf(rows, now, sessionStart),
    fills: fills
      .slice(-50)
      .reverse()
      .map((f) => fillView(f, base)),
    events: store.recentEvents(bot.id, 30).map((e) => ({
      at: e.time,
      level: e.level,
      message: e.message,
    })),
    notes: describe(store, bot),
    ...followingBinance(store, bot),
  };
}

/** Taker Volume with smart timing: whether its last round followed Binance (state.smart.mode). */
function followingBinance(store: SqliteStore, bot: BotRecord): Pick<BotView, "followingBinance"> {
  if ((bot.config as { smartTiming?: unknown } | undefined)?.smartTiming !== true) return {};
  const state = store.getKV<{ smart?: { mode?: string } }>(bot.id, "strategy");
  return { followingBinance: state?.smart?.mode === "following" };
}

/**
 * Stats for several periods in one replay of the fill history. PnL is the realised
 * PnL of the period's fills after fees, plus the open position's PnL now (every
 * period runs up to now, so it holds the current position).
 */
export function periods<K extends string>(
  chronological: Fill[],
  unrealised: number,
  starts: Record<K, number>,
): Record<K, PeriodStats> {
  return periodsOf(fillRows(chronological), unrealised, starts);
}

/** The same from fills already replayed (fill-history.ts): plain sums, no decimal maths. */
export function periodsOf<K extends string>(
  rows: FillRow[],
  unrealised: number,
  starts: Record<K, number>,
): Record<K, PeriodStats> {
  const out = {} as Record<K, PeriodStats>;
  for (const key of Object.keys(starts) as K[]) {
    const since = starts[key];
    let volume = 0;
    let fills = 0;
    let fees = 0;
    let maker = 0;
    let realised = 0;
    for (let i = firstAt(rows, since); i < rows.length; i++) {
      const r = rows[i]!;
      volume += r.notional;
      fills += 1;
      fees += r.fee;
      if (r.maker) maker += r.notional;
      realised += r.realised;
    }
    const pnl = realised + unrealised;
    out[key] = {
      since,
      volume,
      fills,
      fees,
      makerShare: volume > 0 ? maker / volume : null,
      pnl,
      costPerMillion: volume > 0 ? (-pnl / volume) * 1_000_000 : null,
    };
  }
  return out;
}

/**
 * Volume and realised cost per bar over the current run (`from`, its start), the last day
 * at most. Bar width adapts to how long the run has traded, so a new run gets a chart of its
 * own from its first minutes; fills from before it don't count, even in the bar it started in
 * (the bot page's chart is "this run").
 */
export function bars(chronological: Fill[], now: number, from = 0): { bars: Bar[]; barMs: number } {
  return barsOf(fillRows(chronological), now, from);
}

export function barsOf(rows: FillRow[], now: number, from = 0): { bars: Bar[]; barMs: number } {
  const first = rows[firstAt(rows, Math.max(from, now - DAY))]?.time ?? now;
  const span = now - first;
  const barMs = span <= 2 * HOUR ? 5 * MINUTE : span <= 12 * HOUR ? 30 * MINUTE : HOUR;
  const end = Math.floor(now / barMs) * barMs + barMs;
  const start = end - BARS * barMs;

  const out: (Bar & { pnl: number })[] = Array.from({ length: BARS }, (_, i) => ({
    at: start + i * barMs,
    volume: 0,
    fills: 0,
    costBps: null,
    pnl: 0,
  }));
  // Each fill's realised PnL was replayed over the whole history, so it's right even for
  // fills that close a position opened before the window.
  for (let i = firstAt(rows, Math.max(start, from)); i < rows.length; i++) {
    const r = rows[i]!;
    const bar = out[Math.min(BARS - 1, Math.floor((r.time - start) / barMs))]!;
    bar.volume += r.notional;
    bar.fills += 1;
    bar.pnl += r.realised;
  }
  return {
    barMs,
    bars: out.map(({ pnl, ...bar }) => ({
      ...bar,
      costBps: bar.volume > 0 ? (-pnl / bar.volume) * 10_000 : null,
    })),
  };
}

/** The first row at or after a time (rows are oldest first). */
function firstAt(rows: FillRow[], time: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sumSince(rows: FillRow[], since: number): number {
  let sum = 0;
  for (let i = firstAt(rows, since); i < rows.length; i++) sum += rows[i]!.notional;
  return sum;
}

function countSince(rows: FillRow[], since: number): number {
  return rows.length - firstAt(rows, since);
}

/** A stable positive number per bot, for the id of its synthesized history run. */
function sessionKey(botId: string): number {
  let h = 0;
  for (const ch of botId) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000_007;
  return h + 1;
}

function fillView(f: Fill, baseCoin?: string): FillView {
  const price = n(f.price);
  const quantity = n(f.quantity);
  // In USDC: a spot buy's fee is in the coin bought (fill-history.ts spotBase).
  return {
    id: f.tradeId,
    at: f.time,
    side: f.side,
    price,
    quantity,
    notional: price * quantity,
    fee: feeInBase(f, baseCoin) ? n(f.fee) * price : n(f.fee),
    maker: f.isMaker !== false,
  };
}

/** Copy the numeric fields we know (bot files may hold decimals as strings). */
function pickNumbers<K extends string>(
  source: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const v = source[key];
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) {
      out[key] = Number(v);
    }
  }
  return out;
}

export function pickConfig(config: unknown): BotView["config"] {
  const raw = (config ?? {}) as Record<string, unknown>;
  const picked: BotView["config"] = pickNumbers(raw, [
    "orderSize",
    "levels",
    "maxInventory",
    "maxActionsPerDollar",
    "leverage",
    "volumeTarget",
    // Grid bots.
    "lower",
    "upper",
    "grids",
    "investment",
    "window",
    "stopLossLow",
    "stopLossHigh",
  ]);
  if (typeof raw.type === "string") picked.type = raw.type;
  if (typeof raw.spacing === "string") picked.spacing = raw.spacing;
  if (raw.smartTiming === true) picked.smartTiming = true;
  // Older bot files: dailyVolumeTarget now means the run's target too.
  if (picked.volumeTarget === undefined && Number(raw.dailyVolumeTarget) > 0)
    picked.volumeTarget = Number(raw.dailyVolumeTarget);
  // Bot files from the first Profit Maker: its largest position was orderSize × maxEntries.
  if (picked.maxInventory === undefined && picked.orderSize && Number(raw.maxEntries) > 0)
    picked.maxInventory = picked.orderSize * Number(raw.maxEntries);
  return picked;
}

function pickRisk(risk: Record<string, unknown> | undefined): BotView["risk"] {
  if (!risk) return null;
  return pickNumbers(risk, ["maxNotional", "maxLoss", "maxOpenOrders", "maxLeverage"]);
}

function describe(store: SqliteStore, bot: BotRecord): string[] {
  const strategy = STRATEGIES[bot.strategy];
  const state = store.getKV<unknown>(bot.id, "strategy");
  if (!strategy?.describe || state === undefined) return [];
  try {
    return strategy.describe(bot.config, state);
  } catch {
    return [];
  }
}
