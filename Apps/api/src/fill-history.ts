import {
  applyFill,
  emptyPosition,
  type BotRecord,
  type Fill,
  type PositionState,
  type SqliteStore,
} from "@sodextra/engine-core";

/**
 * A spot bot's base coin ("vPEPE" for vPEPE_vUSDC). A spot buy pays its fee in it, so the
 * replay must know it to count that fee in USDC (fee × price), not as that many dollars.
 */
export function spotBase(bot: Pick<BotRecord, "market" | "symbol">): string | undefined {
  return bot.market === "spot" ? bot.symbol.split("_")[0] : undefined;
}

/** One fill as plain numbers: what the period and bar sums need, replayed once. */
export interface FillRow {
  time: number;
  notional: number;
  /** Fee of this fill (USDC). */
  fee: number;
  /** Realised PnL this fill booked, after its fee. */
  realised: number;
  maker: boolean;
}

interface History {
  /** Oldest first. Shared: never mutate. */
  fills: Fill[];
  rows: FillRow[];
  /** Position after the last fill, to continue the replay from. */
  state: PositionState;
  lastTime: number;
  /** Trade ids at lastTime (a new fill can share that millisecond). */
  atLast: Set<string>;
  /** When each run started from flat (oldest first), and how many of those the replay passed. */
  flatAt: number[];
  flatPassed: number;
}

/** Per store, then per bot (tests open many stores whose bots share ids). */
const caches = new WeakMap<SqliteStore, Map<string, History>>();

/**
 * A bot's fills, oldest first, with each one's numbers replayed once. The API used to read
 * and replay every fill on each request (≈ 250 ms per bot page at 20k fills, every 2 s
 * per viewer, blocking every other request meanwhile); now only new fills are read and
 * replayed. A fill inserted out of order (an older time after a reconcile) or a deleted
 * bot rebuilds it from scratch.
 */
export function fillHistory(store: SqliteStore, botId: string, baseCoin?: string): History {
  const { count, last } = store.fillStats(botId);
  // A new run starts flat (the engine closes or drops what the last run left first): the
  // replay does too, so a gap in an earlier run's history can't carry into later ones.
  const flatAt = store.eventTimes(botId, "new-run");
  let cache = caches.get(store);
  if (!cache) caches.set(store, (cache = new Map()));
  const cached = cache.get(botId);
  const hit = cached && cached.flatAt.length === flatAt.length ? cached : undefined;
  if (hit && hit.fills.length === count && (count === 0 || hit.lastTime === last)) return hit;
  if (hit && count > hit.fills.length && last !== undefined && last >= hit.lastTime) {
    const fresh = store
      .listFillsFrom(botId, hit.lastTime)
      .filter((f) => f.time > hit.lastTime || !hit.atLast.has(f.tradeId));
    if (hit.fills.length + fresh.length === count) {
      append(hit, fresh, baseCoin);
      return hit;
    }
  }
  const built: History = {
    fills: [],
    rows: [],
    state: emptyPosition(),
    lastTime: 0,
    atLast: new Set(),
    flatAt,
    flatPassed: 0,
  };
  append(built, store.listFills(botId).reverse(), baseCoin);
  cache.set(botId, built);
  return built;
}

/**
 * The same numbers for a list of fills (oldest first), without the cache. `flatAt`: when
 * runs started from flat (the position resets there).
 */
export function fillRows(
  chronological: Fill[],
  baseCoin?: string,
  flatAt: number[] = [],
): FillRow[] {
  const h: History = {
    fills: [],
    rows: [],
    state: emptyPosition(),
    lastTime: 0,
    atLast: new Set(),
    flatAt,
    flatPassed: 0,
  };
  append(h, chronological, baseCoin);
  return h.rows;
}

function append(h: History, fills: Fill[], baseCoin: string | undefined): void {
  // Copy-on-write: callers may still hold the previous arrays.
  h.fills = [...h.fills, ...fills];
  const rows = [...h.rows];
  for (const f of fills) {
    // A run started from flat since the last fill: drop what the replay still held (its
    // realised PnL and fees so far stay as they are).
    while (h.flatPassed < h.flatAt.length && h.flatAt[h.flatPassed]! <= f.time) {
      h.state = { ...h.state, size: "0", avgEntry: "0" };
      h.flatPassed += 1;
    }
    const before = h.state;
    h.state = applyFill(h.state, f, baseCoin);
    const fee = Number(h.state.fees) - Number(before.fees);
    rows.push({
      time: f.time,
      notional: Number(f.price) * Number(f.quantity),
      fee,
      realised: Number(h.state.realizedPnl) - Number(before.realizedPnl) - fee,
      maker: f.isMaker !== false,
    });
    if (f.time > h.lastTime) {
      h.lastTime = f.time;
      h.atLast = new Set();
    }
    if (f.time === h.lastTime) h.atLast.add(f.tradeId);
  }
  h.rows = rows;
}
