import type { PerpsSymbol } from "@sodextra/sodex-client";

import {
  BacktestExchange,
  BotEngine,
  SqliteStore,
  type BotRecord,
  type DesiredOrder,
  type Fill,
  type RiskLimits,
  type Strategy,
  type TrackedOrder,
} from "../src/index.ts";

export const BTC: PerpsSymbol = {
  id: 1,
  name: "BTC-USD",
  displayName: "BTC-USD",
  baseCoin: "BTC",
  quoteCoinID: 0,
  pricePrecision: 0,
  tickSize: "1",
  minPrice: "1",
  maxPrice: "0",
  quantityPrecision: 5,
  stepSize: "0.00001",
  minQuantity: "0.00001",
  maxQuantity: "0",
  marketMinQuantity: "0.00001",
  marketMaxQuantity: "0",
  minNotional: "10",
  maxNotional: "4000000",
  buyLimitUpRatio: "0.05",
  sellLimitDownRatio: "0.05",
  marketDeviationRatio: "0.025",
  maxLeverage: 40,
  initLeverage: 20,
  marginTiers: [],
  status: "TRADING",
};

/** A strategy the test controls directly: whatever is in `want` is desired. */
export function scripted() {
  const calls = { fills: [] as Fill[], closed: [] as TrackedOrder[] };
  const control = { want: [] as DesiredOrder[] };
  const strategy: Strategy<Record<string, never>, { fills: number }> = {
    name: "scripted",
    idPrefix: "t",
    parseConfig: () => ({}),
    validate: () => ({ ok: true, errors: [], warnings: [], summary: [] }),
    initialState: () => ({ fills: 0 }),
    onFill: (_ctx, state, fill) => {
      state.fills += 1;
      calls.fills.push(fill);
    },
    onOrderClosed: (_ctx, _state, order) => {
      calls.closed.push(order);
    },
    desired: () => control.want,
  };
  return { strategy, control, calls };
}

export function setup(
  options: {
    scripted?: ReturnType<typeof scripted>;
    store?: SqliteStore;
    exchange?: BacktestExchange;
    bot?: BotRecord;
    risk?: Partial<RiskLimits>;
    deadManShared?: () => boolean;
    stopWhenPausedMs?: number;
  } = {},
) {
  const store = options.store ?? new SqliteStore(":memory:");
  const exchange =
    options.exchange ??
    new BacktestExchange({
      market: "perps",
      symbol: BTC,
      makerFee: "0.00012",
      takerFee: "0.0004",
      quoteBalance: "1000",
      startTime: 1_000_000,
    });
  const bot: BotRecord =
    options.bot ??
    ({
      id: "testbot1",
      name: "test",
      strategy: "scripted",
      symbol: "BTC-USD",
      market: "perps",
      mode: "backtest",
      config: {},
      status: "created",
      createdAt: 0,
      updatedAt: 0,
    } satisfies BotRecord);
  if (!store.getBot(bot.id)) store.createBot(bot);
  const s = options.scripted ?? scripted();
  const events: { level: string; type: string; message: string }[] = [];
  const engine = new BotEngine({
    bot,
    strategy: s.strategy,
    config: {},
    exchange,
    store,
    risk: { staleDataMs: 60_000, driftRecheckMs: 0, ...options.risk },
    onEvent: (e) => events.push(e),
    ...(options.deadManShared ? { deadManShared: options.deadManShared } : {}),
    ...(options.stopWhenPausedMs ? { stopWhenPausedMs: options.stopWhenPausedMs } : {}),
  });
  return { engine, exchange, store, bot, events, ...s };
}

export const limit = (
  key: string,
  side: "BUY" | "SELL",
  price: string,
  quantity: string,
  extra: Partial<DesiredOrder> = {},
): DesiredOrder => ({
  key,
  side,
  kind: "limit",
  price,
  quantity,
  ...extra,
});
