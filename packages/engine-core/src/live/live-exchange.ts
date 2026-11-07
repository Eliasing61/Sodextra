import {
  canonicalDecimal,
  toDecimal,
  MarginMode,
  OrderModifier,
  OrderSide,
  OrderType,
  SodexApiError,
  SodexNetworkError,
  SodexWsClient,
  StopType,
  TimeInForce,
  TriggerType,
  type Address,
  type BatchItemResult,
  type MarketSymbol,
  type PerpsOrder,
  type SodexClient,
  type SpotOrder,
  type Uint64,
  type UserTrade,
  type WsPush,
} from "@sodextra/sodex-client";

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
import { QuietBookPoll } from "./book-poll.ts";

export interface LiveOptions {
  /** A client created with an ActionSigner (the API key). */
  client: SodexClient;
  user: Address;
  accountID: Uint64;
  market: MarketKind;
  symbol: MarketSymbol;
  /** A SoDEX builder code to put on every new order (the user must have approved it). */
  builder?: { id: number; fee: number } | undefined;
}

type Row = Record<string, unknown>;
const rows = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];
const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

const STATUS: Record<string, ExchangeOrder["status"]> = {
  NEW: "open",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELED: "canceled",
  REJECTED: "rejected",
  EXPIRED: "expired",
  TRIGGERED: "open",
};

/** Real SoDEX: signed REST for actions, WebSocket for market and account events, REST for recovery. */
export class LiveExchange implements ExchangeAdapter {
  readonly mode = "live" as const;
  readonly market: MarketKind;
  readonly symbol: MarketSymbol;
  readonly #o: LiveOptions;
  #ws: SodexWsClient | undefined;
  #poll: QuietBookPoll | undefined;

  constructor(options: LiveOptions) {
    if (!options.client.signer)
      throw new Error("Live trading needs a client with a signer (API key)");
    this.#o = options;
    this.market = options.market;
    this.symbol = options.symbol;
  }

  now(): number {
    return Date.now();
  }

  get #api() {
    return this.market === "perps" ? this.#o.client.perps : this.#o.client.spot;
  }

  async start(handlers: ExchangeHandlers): Promise<void> {
    const name = this.symbol.name;
    const { user } = this.#o;
    const accountID = Number(this.#o.accountID);

    // Seed prices so the first cycle doesn't wait for a push.
    const book = await this.#api.orderbook(name, 1);
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid && ask) handlers.onMarket({ type: "book", bid, ask, time: Date.now() });
    if (this.market === "perps") {
      const mark = (await this.#o.client.perps.markPrices()).find((m) => m.symbol === name);
      if (mark) handlers.onMarket({ type: "mark", price: mark.markPrice, time: Date.now() });
    }

    const ws = new SodexWsClient({
      network: this.#o.client.network,
      engine: this.market,
      onReconnected: () => handlers.onResync(),
      onSubscribeError: (params, error) =>
        handlers.onWarning?.(`Subscription to ${params.channel} failed: ${error}`),
      onError: (error) =>
        handlers.onWarning?.(
          `WebSocket: ${error instanceof Error ? error.message : "connection error"}`,
        ),
    });
    this.#ws = ws;
    // The stream is silent while the best prices don't change: thin spot pairs, and calm
    // perps markets whose mark doesn't move either.
    this.#poll = new QuietBookPoll({
      fetch: async () => {
        const t = (await this.#api.bookTickers(name)).find((x) => x.symbol === name);
        return t && t.bidPx && t.askPx
          ? { bid: t.bidPx, ask: t.askPx, bidSize: t.bidSz, askSize: t.askSz }
          : undefined;
      },
      emit: (bid, ask, bidSize, askSize) =>
        handlers.onMarket({ type: "book", bid, ask, bidSize, askSize, time: Date.now() }),
      quietMs: this.market === "spot" ? 1_500 : 2_500,
    });

    ws.subscribe({ channel: "bookTicker", symbols: [name] }, (m: WsPush) => {
      for (const r of rows(m.data)) {
        if (r.b !== undefined && r.a !== undefined) {
          this.#poll?.touch();
          handlers.onMarket({
            type: "book",
            bid: String(r.b),
            ask: String(r.a),
            bidSize: str(r.B),
            askSize: str(r.A),
            time: Date.now(),
          });
        }
      }
    });
    if (this.market === "perps") {
      ws.subscribe({ channel: "markPrice", symbols: [name] }, (m: WsPush) => {
        for (const r of rows(m.data)) {
          if (r.s === name && r.p !== undefined) {
            this.#poll?.touch();
            handlers.onMarket({
              type: "mark",
              price: String(r.p),
              index: str(r.i),
              time: Date.now(),
            });
          }
        }
      });
    }
    ws.subscribe(
      { channel: "accountOrderUpdate", user, accountID, symbols: [name] },
      (m: WsPush) => {
        for (const r of rows(m.data)) {
          const clOrdID = str(r.c);
          const status = STATUS[String(r.X)];
          if (!clOrdID || !status) continue;
          handlers.onAccount({
            type: "order",
            clOrdID,
            orderId: str(r.i),
            status,
            filledQty: str(r.z),
            reason: str(r.r),
            time: Number(r.T ?? Date.now()),
          });
        }
      },
    );
    ws.subscribe({ channel: "accountTrade", user, accountID, symbols: [name] }, (m: WsPush) => {
      for (const r of rows(m.data)) {
        const clOrdID = str(r.c);
        if (!clOrdID || r.t === undefined) continue;
        handlers.onAccount({
          type: "fill",
          fill: {
            tradeId: String(r.t),
            clOrdID,
            orderId: str(r.i),
            side: r.S === "SELL" ? "SELL" : "BUY",
            price: String(r.p),
            quantity: String(r.q),
            fee: String(r.f ?? "0"),
            builderFee: str(r.bf),
            isMaker: r.m === true,
            time: Number(r.T ?? Date.now()),
          },
        });
      }
    });
    ws.connect();
    this.#poll?.start();
  }

  async stop(): Promise<void> {
    this.#poll?.stop();
    this.#ws?.close();
    this.#ws = undefined;
  }

  reconnect(): void {
    this.#ws?.reconnect();
  }

  async snapshot(): Promise<AccountSnapshot> {
    const { user, accountID } = this.#o;
    const open = await this.#api.openOrders(user, { accountID, symbol: this.symbol.name });
    const openOrders = (open.orders as (SpotOrder | PerpsOrder)[]).map(toExchangeOrder);

    if (this.market === "perps") {
      const state = await this.#o.client.perps.state(user, { accountID });
      const pos = state.P.find((p) => p.s === this.symbol.name);
      return {
        time: Date.now(),
        openOrders,
        position: {
          size: pos?.sz ?? "0",
          entryPrice: pos?.ep,
          liquidationPrice: pos?.lp,
          unrealizedPnl: pos?.ur,
        },
        // Cross margin free to use: USDC plus every collateral coin, at its haircut.
        availableQuote: state.am,
      };
    }
    const balances = await this.#o.client.spot.balances(user, { accountID });
    const spot = this.symbol as { baseCoin?: string };
    const base = balances.balances.find((b) => b.coin === spot.baseCoin);
    const quote = balances.balances.find((b) => b.coin === "vUSDC");
    return {
      time: Date.now(),
      openOrders,
      position: { size: base?.total ?? "0" },
      availableQuote: quote ? canonicalDecimal(toDecimal(quote.total).minus(quote.locked)) : "0",
    };
  }

  async fillsSince(sinceMs: number): Promise<Fill[]> {
    const trades = await this.#api.userTrades(this.#o.user, {
      accountID: this.#o.accountID,
      symbol: this.symbol.name,
      startTime: sinceMs,
      limit: 1000,
    });
    return trades.map(toFill);
  }

  async findOrder(clOrdID: string): Promise<ExchangeOrder | undefined> {
    const { user, accountID } = this.#o;
    const open = await this.#api.openOrders(user, { accountID, symbol: this.symbol.name });
    const live = (open.orders as (SpotOrder | PerpsOrder)[]).find((o) => o.clOrdID === clOrdID);
    if (live) return toExchangeOrder(live);
    const history = await this.#api.orderHistory(user, {
      accountID,
      symbol: this.symbol.name,
      limit: 200,
    });
    const past = (history as (SpotOrder | PerpsOrder)[]).find((o) => o.clOrdID === clOrdID);
    return past ? toExchangeOrder(past) : undefined;
  }

  async place(requests: PlaceRequest[]): Promise<ActionResult[]> {
    if (requests.length === 0) return [];
    const accountID = this.#o.accountID;
    return this.#batch(
      requests.map((r) => r.clOrdID),
      () => {
        if (this.market === "perps") {
          return this.#o.client.perps.placeOrders({
            accountID,
            symbolID: this.symbol.id,
            orders: requests.map((r) => ({
              clOrdID: r.clOrdID,
              modifier: r.kind === "stop" ? OrderModifier.STOP : OrderModifier.NORMAL,
              side: r.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
              type: r.kind === "limit" ? OrderType.LIMIT : OrderType.MARKET,
              timeInForce: TimeInForce[r.kind === "limit" ? r.timeInForce : "IOC"],
              ...(r.kind === "limit" ? { price: r.price } : {}),
              ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
              ...(r.kind === "stop"
                ? {
                    stopPrice: r.stopPrice,
                    stopType: StopType[r.stopType ?? "STOP_LOSS"],
                    triggerType: TriggerType.MARK_PRICE,
                  }
                : {}),
              reduceOnly: r.reduceOnly,
            })),
            builder: this.#o.builder,
          });
        }
        return this.#o.client.spot.placeOrders({
          accountID,
          orders: requests.map((r) => {
            if (r.kind === "stop") throw new Error("Stop orders are not available on spot");
            return {
              symbolID: this.symbol.id,
              clOrdID: r.clOrdID,
              side: r.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
              type: r.kind === "limit" ? OrderType.LIMIT : OrderType.MARKET,
              timeInForce: TimeInForce[r.kind === "limit" ? r.timeInForce : "IOC"],
              ...(r.kind === "limit" ? { price: r.price } : {}),
              ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
            };
          }),
          builder: this.#o.builder,
        });
      },
    );
  }

  async cancel(clOrdIDs: string[]): Promise<ActionResult[]> {
    if (clOrdIDs.length === 0) return [];
    const accountID = this.#o.accountID;
    const symbolID = this.symbol.id;
    if (this.market === "perps") {
      return this.#batch(clOrdIDs, () =>
        this.#o.client.perps.cancelOrders({
          accountID,
          cancels: clOrdIDs.map((clOrdID) => ({ symbolID, clOrdID })),
        }),
      );
    }
    // Spot cancels carry their own request ID; map results back to the original orders.
    const requestIds = clOrdIDs.map((id) => `${id.slice(0, 34)}-x`);
    const results = await this.#batch(requestIds, () =>
      this.#o.client.spot.cancelOrders({
        accountID,
        cancels: clOrdIDs.map((origClOrdID, i) => ({
          symbolID,
          clOrdID: requestIds[i]!,
          origClOrdID,
        })),
      }),
    );
    return results.map((r, i) => ({ ...r, clOrdID: clOrdIDs[i]! }));
  }

  async replace(requests: ReplaceRequest[]): Promise<ActionResult[]> {
    if (requests.length === 0) return [];
    const api = this.#api;
    return this.#batch(
      requests.map((r) => r.clOrdID),
      () =>
        api.replaceOrders({
          accountID: this.#o.accountID,
          orders: requests.map((r) => ({
            symbolID: this.symbol.id,
            clOrdID: r.clOrdID,
            origClOrdID: r.origClOrdID,
            ...(r.price !== undefined ? { price: r.price } : {}),
            ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
          })),
        }),
    );
  }

  /** SoDEX schedule-cancel: cancels ALL of the account's open orders on this engine at `atMs`. */
  async scheduleCancel(atMs: number | undefined): Promise<void> {
    await this.#api.scheduleCancel({
      accountID: this.#o.accountID,
      ...(atMs !== undefined ? { scheduledTimestamp: atMs } : {}),
    });
  }

  async actionBudget(): Promise<{ remaining: number; quota: number }> {
    const r = await this.#o.client.user.rateLimit(this.#o.user);
    return { remaining: Number(r.transactionQuotaRemaining), quota: Number(r.transactionQuota) };
  }

  async setLeverage(leverage: number, marginMode: "ISOLATED" | "CROSS"): Promise<void> {
    if (this.market !== "perps") return; // spot has no leverage
    await this.#o.client.perps.updateLeverage({
      accountID: this.#o.accountID,
      symbolID: this.symbol.id,
      leverage,
      marginMode: MarginMode[marginMode],
    });
  }

  /** Map a batch response to per-order results, including whole-batch rejections and unknown outcomes. */
  async #batch(ids: string[], send: () => Promise<BatchItemResult[]>): Promise<ActionResult[]> {
    try {
      const results = await send();
      if (results.length === 1 && ids.length > 1 && results[0]!.code !== 0) {
        return ids.map((clOrdID) => ({
          clOrdID,
          ok: false,
          error: results[0]!.error ?? `code ${results[0]!.code}`,
        }));
      }
      return ids.map((clOrdID, i) => {
        const r = results.find((x) => x.clOrdID === clOrdID) ?? results[i];
        if (!r) return { clOrdID, ok: false, unknown: true, error: "missing from response" };
        return r.code === 0
          ? { clOrdID, ok: true, orderId: str(r.orderID) }
          : { clOrdID, ok: false, error: r.error ?? `code ${r.code}` };
      });
    } catch (error) {
      if (error instanceof SodexNetworkError)
        return ids.map((clOrdID) => ({ clOrdID, ok: false, unknown: true, error: error.message }));
      if (error instanceof SodexApiError)
        return ids.map((clOrdID) => ({ clOrdID, ok: false, error: error.apiMessage }));
      throw error;
    }
  }
}

function toExchangeOrder(o: SpotOrder | PerpsOrder): ExchangeOrder {
  const perps = o as Partial<PerpsOrder>;
  return {
    clOrdID: o.clOrdID,
    orderId: String(o.orderID),
    side: o.side === "SELL" ? "SELL" : "BUY",
    kind: perps.stopPrice && perps.stopType ? "stop" : o.type === "MARKET" ? "market" : "limit",
    price: o.price,
    quantity: o.origQty,
    filledQty: o.executedQty ?? "0",
    status: STATUS[o.status] ?? "open",
    reduceOnly: perps.reduceOnly ?? false,
    stopPrice: perps.stopPrice,
  };
}

function toFill(t: UserTrade): Fill {
  return {
    tradeId: String(t.tradeID),
    clOrdID: t.clOrdID,
    orderId: String(t.orderID),
    side: t.side === "SELL" ? "SELL" : "BUY",
    price: t.price,
    quantity: t.quantity,
    fee: t.fee ?? "0",
    feeCoin: t.feeCoin,
    builderFee: t.builderFee,
    isMaker: t.isMaker,
    time: t.time,
  };
}
