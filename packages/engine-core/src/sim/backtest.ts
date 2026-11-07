import { canonicalDecimal, toDecimal, type Kline, type MarketSymbol } from "@sodextra/sodex-client";

import { BotEngine, type RiskLimits } from "../engine.ts";
import { newBotId } from "../ids.ts";
import { totalPnl } from "../position.ts";
import { SqliteStore } from "../store/sqlite-store.ts";
import type { Strategy } from "../strategy.ts";
import type {
  AccountSnapshot,
  ActionResult,
  ExchangeAdapter,
  ExchangeHandlers,
  ExchangeOrder,
  Fill,
  MarketKind,
  PlaceRequest,
  ReplaceRequest,
} from "../types.ts";
import { SimCore } from "./sim-core.ts";

/** Exchange adapter driven by historical candles on a simulated clock. */
export class BacktestExchange implements ExchangeAdapter {
  readonly mode = "backtest" as const;
  readonly market: MarketKind;
  readonly symbol: MarketSymbol;
  readonly core: SimCore;
  #handlers: ExchangeHandlers | undefined;
  #time: number;
  #price: string | undefined;

  constructor(options: {
    market: MarketKind;
    symbol: MarketSymbol;
    makerFee: string;
    takerFee: string;
    quoteBalance: string;
    baseBalance?: string;
    startTime: number;
  }) {
    this.market = options.market;
    this.symbol = options.symbol;
    this.#time = options.startTime;
    this.core = new SimCore({
      symbol: options.symbol,
      market: options.market,
      makerFee: options.makerFee,
      takerFee: options.takerFee,
      quoteBalance: options.quoteBalance,
      ...(options.baseBalance !== undefined ? { baseBalance: options.baseBalance } : {}),
      now: () => this.#time,
      emit: (event) => this.#handlers?.onAccount(event),
    });
  }

  now(): number {
    return this.#time;
  }

  /** Move the clock and the market to one point on the price path. */
  tick(time: number, price: string): void {
    this.#time = time;
    this.#price = price;
    this.core.walk(price);
    this.#emitMarket(time, price);
  }

  #emitMarket(time: number, price: string): void {
    const tick = toDecimal(this.symbol.tickSize);
    const p = toDecimal(price);
    this.#handlers?.onMarket({
      type: "book",
      bid: canonicalDecimal(p.minus(tick)),
      ask: canonicalDecimal(p.plus(tick)),
      time,
    });
    if (this.market === "perps") this.#handlers?.onMarket({ type: "mark", price, time });
  }

  /** Like the live adapters, seed the current price on connect. */
  async start(handlers: ExchangeHandlers): Promise<void> {
    this.#handlers = handlers;
    if (this.#price !== undefined) this.#emitMarket(this.#time, this.#price);
  }
  async stop(): Promise<void> {}
  async snapshot(): Promise<AccountSnapshot> {
    return this.core.snapshot();
  }
  async fillsSince(sinceMs: number): Promise<Fill[]> {
    return this.core.fillsSince(sinceMs);
  }
  async findOrder(clOrdID: string): Promise<ExchangeOrder | undefined> {
    return this.core.findOrder(clOrdID);
  }
  async place(requests: PlaceRequest[]): Promise<ActionResult[]> {
    return this.core.place(requests);
  }
  async cancel(clOrdIDs: string[]): Promise<ActionResult[]> {
    return this.core.cancel(clOrdIDs);
  }
  async replace(requests: ReplaceRequest[]): Promise<ActionResult[]> {
    return this.core.replace(requests);
  }
  async setLeverage(): Promise<void> {}
}

/**
 * Price path inside one candle. Bullish candles are assumed to dip first
 * (open → low → high → close), bearish ones to spike first (open → high → low → close).
 */
export function candlePath(k: Pick<Kline, "o" | "h" | "l" | "c">): string[] {
  const bullish = toDecimal(k.c).gte(k.o);
  return bullish ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
}

export interface BacktestOptions<C, S> {
  strategy: Strategy<C, S>;
  config: C;
  market: MarketKind;
  symbol: MarketSymbol;
  /** Candles in ascending time order (1-minute recommended). */
  candles: Kline[];
  candleMs: number;
  makerFee: string;
  takerFee: string;
  quoteBalance: string;
  baseBalance?: string;
  risk?: Partial<RiskLimits>;
}

export interface BacktestReport {
  from: number;
  to: number;
  candles: number;
  fills: number;
  volume: string;
  fees: string;
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
  finalPosition: string;
  finalPrice: string;
  /** Largest peak-to-trough fall in total PnL, sampled at each candle close. */
  maxDrawdown: string;
  status: string;
  statusReason?: string | undefined;
  events: { level: string; message: string }[];
  /** The strategy's final state, for strategy-specific stats (see Strategy.describe). */
  strategyState: unknown;
}

export async function runBacktest<C, S>(options: BacktestOptions<C, S>): Promise<BacktestReport> {
  const candles = options.candles;
  if (candles.length === 0) throw new Error("No candles to backtest");
  const start = candles[0]!.t;

  const store = new SqliteStore(":memory:");
  const exchange = new BacktestExchange({
    market: options.market,
    symbol: options.symbol,
    makerFee: options.makerFee,
    takerFee: options.takerFee,
    quoteBalance: options.quoteBalance,
    ...(options.baseBalance !== undefined ? { baseBalance: options.baseBalance } : {}),
    startTime: start,
  });
  const bot = {
    id: newBotId(),
    name: "backtest",
    strategy: options.strategy.name,
    symbol: options.symbol.name,
    market: options.market,
    mode: "backtest" as const,
    config: options.config,
    status: "created" as const,
    createdAt: start,
    updatedAt: start,
  };
  store.createBot(bot);
  const events: BacktestReport["events"] = [];
  const engine = new BotEngine({
    bot,
    strategy: options.strategy,
    config: options.config,
    exchange,
    store,
    risk: {
      staleDataMs: Number.MAX_SAFE_INTEGER,
      stalePullMs: Number.MAX_SAFE_INTEGER,
      staleReconnectMs: Number.MAX_SAFE_INTEGER,
      ...options.risk,
    },
    batchSize: 1_000,
    onEvent: (e) => {
      if (e.level !== "info" || e.type === "stop-requested")
        events.push({ level: e.level, message: e.message });
    },
  });

  exchange.tick(start, canonicalDecimal(candles[0]!.o));
  await engine.start();

  let peak = toDecimal(0);
  let maxDrawdown = toDecimal(0);
  for (const candle of candles) {
    const path = candlePath(candle).map((p) => canonicalDecimal(p));
    for (let i = 0; i < path.length; i++) {
      exchange.tick(candle.t + Math.floor((options.candleMs * i) / path.length), path[i]!);
      await engine.cycle();
    }
    const pnl = toDecimal(totalPnl(engine.summary().position, candle.c));
    if (pnl.gt(peak)) peak = pnl;
    if (peak.minus(pnl).gt(maxDrawdown)) maxDrawdown = peak.minus(pnl);
    if (engine.status === "stopped") break;
  }

  const last = candles[candles.length - 1]!;
  const summary = engine.summary();
  store.close();
  return {
    from: start,
    to: last.t + options.candleMs,
    candles: candles.length,
    fills: summary.position.fillCount,
    volume: summary.position.volume,
    fees: summary.position.fees,
    realizedPnl: summary.position.realizedPnl,
    unrealizedPnl: summary.unrealizedPnl,
    totalPnl: summary.totalPnl,
    finalPosition: summary.position.size,
    finalPrice: last.c,
    maxDrawdown: canonicalDecimal(maxDrawdown),
    status: summary.status,
    strategyState: engine.strategyState,
    statusReason: summary.statusReason,
    events,
  };
}
