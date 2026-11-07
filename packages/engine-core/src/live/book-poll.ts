/**
 * SoDEX's bookTicker stream pushes only when the best bid or ask changes, so a quiet spot
 * pair (minutes without a change) looks like a dead feed and the engine pulls its quotes.
 * While the stream is quiet, read the best prices over REST instead (bookTickers for one
 * symbol: weight 2), at most once per `quietMs`.
 */
/** Best prices read over REST, with the sizes resting there when known. */
export interface PolledBook {
  bid: string;
  ask: string;
  bidSize?: string | undefined;
  askSize?: string | undefined;
}

export class QuietBookPoll {
  readonly #fetch: () => Promise<PolledBook | undefined>;
  readonly #emit: (bid: string, ask: string, bidSize?: string, askSize?: string) => void;
  readonly #quietMs: number;
  #lastAt = 0;
  #busy = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(o: {
    fetch: () => Promise<PolledBook | undefined>;
    emit: (bid: string, ask: string, bidSize?: string, askSize?: string) => void;
    quietMs?: number;
  }) {
    this.#fetch = o.fetch;
    this.#emit = o.emit;
    // Well under the engine's 5 s pull, even with a slow request.
    this.#quietMs = o.quietMs ?? 1_500;
  }

  /** A price arrived (from the stream or a poll). */
  touch(): void {
    this.#lastAt = Date.now();
  }

  start(): void {
    this.touch();
    this.#timer ??= setInterval(() => void this.#tick(), 500);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    if (this.#busy || Date.now() - this.#lastAt < this.#quietMs) return;
    this.#busy = true;
    try {
      const book = await this.#fetch();
      // A real outage leaves the engine's stale-feed guard to act.
      if (book && this.#timer) {
        this.touch();
        this.#emit(book.bid, book.ask, book.bidSize, book.askSize);
      }
    } catch {
      // Same: no price, no touch.
    } finally {
      this.#busy = false;
    }
  }
}
