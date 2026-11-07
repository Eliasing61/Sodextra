import type { ExchangeAdapter, ExchangeHandlers } from "../types.ts";

/**
 * Binance USDⓈ-M futures, public route (no key). `<symbol>@depth5@100ms` is the top of the
 * book every 100 ms: at most 10 messages a second, where `@bookTicker` sends hundreds.
 */
const BINANCE_PUBLIC_WS = "wss://fstream.binance.com/public/ws";

/**
 * Binance's limits (developers.binance.com, 2026-11): a connection lives at most 24 h;
 * Binance pings every 3 min and drops a connection that hasn't answered in 10 min (Node's
 * WebSocket answers pings itself); at most 300 connection attempts per IP per 5 min, and
 * breaking limits gets the IP banned. So one connection per bot, nothing sent on it, and
 * reconnects that back off: after a failure 5 s, 15 s, 30 s, 1 min, 2 min, then every
 * 5 min (±20%). A bot makes at most ~6 attempts in its first 10 minutes of trouble and 1
 * per 5 min after that: 10 bots on one IP stay far under 300.
 */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** A connection that lasted this long was healthy: the next failure starts the backoff over. */
const HEALTHY_MS = 10 * 60_000;
/** Binance closes connections at 24 h: one that lasted this long is reopened at once. */
const PLANNED_CLOSE_MS = 23 * 3_600_000;
/** No data for this long on an open connection: it's dead, open a new one. */
const SILENT_MS = 30_000;
/** An unchanged price is passed on again this often, so the strategy knows the feed is alive. */
const RESEND_MS = 1_000;
/** Warnings about the feed at most this often. */
const WARN_EVERY_MS = 10 * 60_000;

export interface FeedSocket {
  close(): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    fn: (ev: { data?: unknown }) => void,
  ): void;
}
export type FeedSocketFactory = (url: string) => FeedSocket;

const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

/**
 * The same market's best prices on Binance, for strategies that trade on its lead: SoDEX's
 * book follows the big exchanges a moment later. Calls back only when the best bid or ask
 * moves. Reconnects on its own within Binance's limits; a strategy treats silence as no signal.
 */
export class BinanceFeed {
  readonly symbol: string;
  readonly #factory: FeedSocketFactory;
  #ws: FeedSocket | undefined;
  #stopped = true;
  #last = "";
  #sentAt = 0;
  #failures = 0;
  #openedAt = 0;
  #lastDataAt = 0;
  #lastWarnAt = -Infinity;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(symbol: string, factory: FeedSocketFactory = (url) => new WebSocket(url)) {
    this.symbol = symbol.toUpperCase();
    this.#factory = factory;
  }

  get url(): string {
    return `${BINANCE_PUBLIC_WS}/${this.symbol.toLowerCase()}@depth5@100ms`;
  }

  start(
    onPrice: (bid: string, ask: string, time: number) => void,
    onWarning?: (message: string) => void,
  ): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const warn = (message: string) => {
      if (Date.now() - this.#lastWarnAt < WARN_EVERY_MS) return;
      this.#lastWarnAt = Date.now();
      onWarning?.(message);
    };

    const reconnect = (why: string) => {
      if (this.#stopped) return;
      const lived = this.#openedAt ? Date.now() - this.#openedAt : 0;
      this.#openedAt = 0;
      let delay: number;
      if (lived >= PLANNED_CLOSE_MS) {
        delay = 1_000;
        this.#failures = 0;
      } else {
        if (lived >= HEALTHY_MS) this.#failures = 0;
        delay = jitter(BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length - 1)]!);
        this.#failures += 1;
        warn(
          `Binance prices for ${this.symbol} unavailable (${why}); trading on the timer, retrying in ${Math.round(delay / 1000)} s`,
        );
      }
      clearTimeout(this.#retry);
      this.#retry = setTimeout(open, delay);
    };

    const open = () => {
      if (this.#stopped) return;
      let ws: FeedSocket;
      try {
        ws = this.#factory(this.url);
      } catch (error) {
        reconnect(error instanceof Error ? error.message : "can't connect");
        return;
      }
      this.#ws = ws;
      this.#lastDataAt = Date.now();
      ws.addEventListener("open", () => {
        if (this.#ws === ws) this.#openedAt = Date.now();
      });
      ws.addEventListener("message", (ev) => {
        if (this.#ws !== ws) return;
        this.#lastDataAt = Date.now();
        let m: { b?: unknown; a?: unknown };
        try {
          m = JSON.parse(String(ev.data)) as { b?: unknown; a?: unknown };
        } catch {
          return;
        }
        const bid = Array.isArray(m.b) ? (m.b[0] as unknown[] | undefined)?.[0] : undefined;
        const ask = Array.isArray(m.a) ? (m.a[0] as unknown[] | undefined)?.[0] : undefined;
        if (typeof bid !== "string" || typeof ask !== "string") return;
        // On a change, and at least once a second while the price sits still: a quiet
        // market isn't a dead feed.
        const key = `${bid}/${ask}`;
        const now = Date.now();
        if (key === this.#last && now - this.#sentAt < RESEND_MS) return;
        this.#last = key;
        this.#sentAt = now;
        onPrice(bid, ask, now);
      });
      ws.addEventListener("close", () => {
        if (this.#ws !== ws) return;
        this.#ws = undefined;
        reconnect("connection closed");
      });
      // An error is followed by a close; the close reconnects.
      ws.addEventListener("error", () => {});
    };

    this.#watchdog = setInterval(() => {
      const ws = this.#ws;
      if (!ws || Date.now() - this.#lastDataAt < SILENT_MS) return;
      this.#ws = undefined;
      try {
        ws.close();
      } catch {
        // already closed
      }
      reconnect(`no data for ${SILENT_MS / 1000} s`);
    }, 5_000);
    open();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearInterval(this.#watchdog);
    const ws = this.#ws;
    this.#ws = undefined;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }
}

/** SoDEX's perps symbol on Binance USDⓈ-M futures, by name ("BTC-USD" → "BTCUSDT"). */
export function binanceSymbol(sodexSymbol: string): string | undefined {
  const m = /^([A-Z0-9]+)-USD$/.exec(sodexSymbol);
  return m ? `${m[1]}USDT` : undefined;
}

/**
 * The exchange, plus the reference feed's prices as "ref" market events. Everything else
 * goes to the exchange itself (the engine checks which optional methods it has).
 */
export function withReference(exchange: ExchangeAdapter, feed: BinanceFeed): ExchangeAdapter {
  return new Proxy(exchange, {
    get(target, prop) {
      if (prop === "start") {
        return async (handlers: ExchangeHandlers) => {
          await target.start(handlers);
          feed.start(
            (bid, ask, time) => handlers.onMarket({ type: "ref", bid, ask, time }),
            (message) => handlers.onWarning?.(message),
          );
        };
      }
      if (prop === "stop") {
        return async () => {
          feed.stop();
          await target.stop();
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
