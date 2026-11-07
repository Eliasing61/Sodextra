import {
  SodexClient,
  SodexWsClient,
  type MarketSymbol,
  type Network,
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
import { QuietBookPoll } from "../live/book-poll.ts";
import { SimCore, type SimState } from "./sim-core.ts";

export interface PaperOptions {
  network: Network;
  market: MarketKind;
  symbol: MarketSymbol;
  makerFee: string;
  takerFee: string;
  quoteBalance: string;
  baseBalance?: string;
  /** Previously saved simulator state, to resume a paper bot. */
  restore?: SimState | undefined;
  /** Called after every simulated change so the runner can save it. */
  persist?: (state: SimState) => void;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);
const rows = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];

/** Paper trading: real-time SoDEX market data, simulated orders and fills. Signs nothing. */
export class PaperExchange implements ExchangeAdapter {
  readonly mode = "paper" as const;
  readonly market: MarketKind;
  readonly symbol: MarketSymbol;
  readonly #o: PaperOptions;
  readonly #rest: SodexClient;
  #ws: SodexWsClient | undefined;
  #poll: QuietBookPoll | undefined;
  #handlers: ExchangeHandlers | undefined;
  readonly #core: SimCore;

  constructor(options: PaperOptions) {
    this.#o = options;
    this.market = options.market;
    this.symbol = options.symbol;
    this.#rest = new SodexClient({ network: options.network });
    this.#core = new SimCore(
      {
        symbol: options.symbol,
        market: options.market,
        makerFee: options.makerFee,
        takerFee: options.takerFee,
        quoteBalance: options.quoteBalance,
        ...(options.baseBalance !== undefined ? { baseBalance: options.baseBalance } : {}),
        now: () => Date.now(),
        queueModel: true,
        emit: (event) => {
          this.#handlers?.onAccount(event);
          this.#o.persist?.(this.#core.state);
        },
      },
      options.restore,
    );
  }

  now(): number {
    return Date.now();
  }

  get simState(): SimState {
    return this.#core.state;
  }

  async start(handlers: ExchangeHandlers): Promise<void> {
    this.#handlers = handlers;
    const name = this.symbol.name;
    const api = this.market === "perps" ? this.#rest.perps : this.#rest.spot;

    // Seed the book (and mark) before streams start so the first cycle has prices.
    const book = await api.orderbook(name, 1);
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid && ask) this.#onBook(bid, ask);
    if (this.market === "perps") {
      const mark = (await this.#rest.perps.markPrices()).find((m) => m.symbol === name);
      if (mark) this.#onMark(mark.markPrice);
    }

    this.#ws = new SodexWsClient({
      network: this.#o.network,
      engine: this.market,
      onReconnected: () => handlers.onResync(),
    });
    // The stream is silent while the best prices don't change: thin spot pairs, and calm
    // perps markets whose mark doesn't move either.
    this.#poll = new QuietBookPoll({
      fetch: async () => {
        const t = (await api.bookTickers(name)).find((x) => x.symbol === name);
        return t && t.bidPx && t.askPx
          ? { bid: t.bidPx, ask: t.askPx, bidSize: t.bidSz, askSize: t.askSz }
          : undefined;
      },
      emit: (bid, ask, bidSize, askSize) => this.#onBook(bid, ask, bidSize, askSize),
      quietMs: this.market === "spot" ? 1_500 : 2_500,
    });
    this.#ws.subscribe({ channel: "bookTicker", symbols: [name] }, (m: WsPush) => {
      for (const r of rows(m.data))
        if (r.b !== undefined && r.a !== undefined) {
          this.#poll?.touch();
          this.#onBook(String(r.b), String(r.a), str(r.B), str(r.A));
        }
    });
    this.#ws.subscribe({ channel: "trade", symbols: [name] }, (m: WsPush) => {
      for (const r of rows(m.data)) {
        if (r.p === undefined) continue;
        const price = String(r.p);
        handlers.onMarket({
          type: "trade",
          price,
          quantity: String(r.q ?? "0"),
          side: r.S === "SELL" ? "SELL" : "BUY",
          time: Date.now(),
        });
        // S is the taker's side: a SELL taker hits resting bids, a BUY taker lifts asks.
        this.#core.onTrade(price, str(r.q), r.S === "SELL" ? "SELL" : "BUY");
      }
    });
    if (this.market === "perps") {
      this.#ws.subscribe({ channel: "markPrice", symbols: [name] }, (m: WsPush) => {
        for (const r of rows(m.data))
          if (r.s === name && r.p !== undefined) {
            this.#poll?.touch();
            this.#onMark(String(r.p), str(r.i));
          }
      });
    }
    this.#ws.connect();
    this.#poll?.start();
  }

  async stop(): Promise<void> {
    this.#poll?.stop();
    this.#ws?.close();
    this.#ws = undefined;
  }

  #onBook(bid: string, ask: string, bidSize?: string, askSize?: string): void {
    this.#core.setBook(bid, ask, bidSize, askSize);
    this.#handlers?.onMarket({ type: "book", bid, ask, bidSize, askSize, time: Date.now() });
  }

  #onMark(price: string, index?: string): void {
    this.#core.setMark(price);
    this.#handlers?.onMarket({ type: "mark", price, index, time: Date.now() });
  }

  async snapshot(): Promise<AccountSnapshot> {
    return this.#core.snapshot();
  }

  async fillsSince(sinceMs: number): Promise<Fill[]> {
    return this.#core.fillsSince(sinceMs);
  }

  async findOrder(clOrdID: string): Promise<ExchangeOrder | undefined> {
    return this.#core.findOrder(clOrdID);
  }

  async place(requests: PlaceRequest[]): Promise<ActionResult[]> {
    const results = this.#core.place(requests);
    this.#o.persist?.(this.#core.state);
    return results;
  }

  async cancel(clOrdIDs: string[]): Promise<ActionResult[]> {
    const results = this.#core.cancel(clOrdIDs);
    this.#o.persist?.(this.#core.state);
    return results;
  }

  async replace(requests: ReplaceRequest[]): Promise<ActionResult[]> {
    const results = this.#core.replace(requests);
    this.#o.persist?.(this.#core.state);
    return results;
  }

  async setLeverage(): Promise<void> {
    // Margin isn't modelled in paper mode.
  }
}
