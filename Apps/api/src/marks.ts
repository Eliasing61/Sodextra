import type { SodexClient } from "@sodextra/sodex-client";

type Market = "spot" | "perps";

const MAX_AGE_MS = 5_000;

/**
 * Mark prices from SoDEX's public tickers, refreshed at most every few seconds per market.
 * A request waits for SoDEX only while a market has no prices yet (just after a restart);
 * otherwise it gets the prices from a few seconds ago at once and new ones load in the
 * background. SoDEX's tickers take about 0.3 s from the server, much longer when it's
 * overloaded, and the dashboard asks every few seconds.
 */
export class MarkCache {
  readonly #client: Pick<SodexClient, "perps" | "spot">;
  readonly #now: () => number;
  readonly #prices = new Map<string, string>();
  readonly #fetchedAt = new Map<Market, number>();
  readonly #loaded = new Set<Market>();
  readonly #loading = new Map<Market, Promise<void>>();

  constructor(client: Pick<SodexClient, "perps" | "spot">, now: () => number = Date.now) {
    this.#client = client;
    this.#now = now;
  }

  get(market: Market, symbol: string): string | undefined {
    return this.#prices.get(`${market}:${symbol}`);
  }

  async refresh(bots: { market: Market }[]): Promise<void> {
    const markets = new Set(bots.map((b) => b.market));
    await Promise.all(
      [...markets].map((m) => {
        const loading = this.#refreshMarket(m);
        return this.#loaded.has(m) ? undefined : loading;
      }),
    );
  }

  /** The market's fetch in flight, or a new one when its prices are older than MAX_AGE_MS. */
  #refreshMarket(market: Market): Promise<void> {
    const inFlight = this.#loading.get(market);
    if (inFlight) return inFlight;
    if (this.#now() - (this.#fetchedAt.get(market) ?? 0) < MAX_AGE_MS) return Promise.resolve();
    this.#fetchedAt.set(market, this.#now());
    const loading = (async () => {
      try {
        const api = market === "perps" ? this.#client.perps : this.#client.spot;
        for (const t of await api.tickers()) {
          this.#prices.set(`${market}:${t.symbol}`, t.markPrice ?? t.lastPx);
        }
        this.#loaded.add(market);
      } catch {
        // Keep the last known prices; the dashboard shows PnL without a fresh mark.
      } finally {
        this.#loading.delete(market);
      }
    })();
    this.#loading.set(market, loading);
    return loading;
  }
}
