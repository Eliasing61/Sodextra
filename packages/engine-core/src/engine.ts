import {
  canonicalDecimal,
  checkOrder,
  OrderSide,
  OrderType,
  roundQuantity,
  toDecimal,
} from "@sodextra/sodex-client";

import { botOrderPrefix, clOrdId } from "./ids.ts";
import { diffOrders } from "./order-diff.ts";
import type { BotRiskSettings } from "./risk.ts";
import {
  applyFill,
  correctFeeCoin,
  emptyPosition,
  totalPnl,
  unrealizedPnl,
  type PositionState,
} from "./position.ts";
import type { SqliteStore } from "./store/sqlite-store.ts";
import type { Strategy, StrategyContext } from "./strategy.ts";
import {
  CLOSED_STATUSES,
  type AccountEvent,
  type BookTop,
  type BotRecord,
  type BotStatus,
  type DesiredOrder,
  type ExchangeAdapter,
  type ExchangeOrder,
  type Fill,
  type MarketEvent,
  type PlaceRequest,
  type ReplaceRequest,
  type TrackedOrder,
} from "./types.ts";

/** The user's per-bot limits plus the engine's own safety timings. */
export interface RiskLimits extends BotRiskSettings {
  /** No new orders when market data is older than this. */
  staleDataMs: number;
  /** Quoting strategies: cancel resting quotes when market data is older than this. */
  stalePullMs: number;
  /** Reconnect the market data stream when nothing has arrived for this long. */
  staleReconnectMs: number;
  /** After an order's outcome is unknown, check with the exchange this soon. */
  unknownRecheckMs: number;
  /** Pause after this many rejected orders in a row. */
  maxConsecutiveRejects: number;
  /** How long a vanished order may stay missing from history before we give up looking (history lags). */
  historyGraceMs: number;
  /** Quoting strategies: how far ahead the exchange dead-man switch is armed. */
  deadManMs: number;
  /** Quoting strategies: stop quoting when fewer address actions than this remain. */
  minActionBudget: number;
  /** On a position mismatch, wait this long and look again before counting it (fills in flight). */
  driftRecheckMs: number;
  /**
   * A mismatch must last this long (seen in two account checks at least this far apart) before
   * the bot pauses: when SoDEX is busy its account data can run seconds behind its trades.
   */
  driftPersistMs: number;
}

export const DEFAULT_RISK: RiskLimits = {
  staleDataMs: 15_000,
  stalePullMs: Number.POSITIVE_INFINITY,
  staleReconnectMs: 20_000,
  unknownRecheckMs: 2_000,
  maxConsecutiveRejects: 5,
  historyGraceMs: 30_000,
  deadManMs: 60_000,
  minActionBudget: 2_000,
  driftRecheckMs: 3_000,
  driftPersistMs: 30_000,
};

export interface EngineOptions<C, S> {
  bot: BotRecord;
  strategy: Strategy<C, S>;
  config: C;
  exchange: ExchangeAdapter;
  store: SqliteStore;
  risk?: Partial<RiskLimits>;
  /** Mirror of every logged event (the CLI prints these). */
  onEvent?: (event: {
    level: "info" | "warn" | "error";
    type: string;
    message: string;
    data?: unknown;
  }) => void;
  /**
   * True while another quoting bot on the same account is running. SoDEX's
   * dead-man switch covers the whole account, so this bot must not clear it then.
   */
  deadManShared?: () => boolean;
  /** Max orders per place/cancel request (≤ 20 keeps under the per-second limit). */
  batchSize?: number;
  /**
   * Stop the bot once it has been paused this long (keeping any position): a paused bot holds
   * its place on the server (a SoDEX connection, a person's spot) without trading. Unset: never.
   */
  stopWhenPausedMs?: number;
}

interface EngineState {
  seq: number;
  position: PositionState;
  setupDone: boolean;
  startedAt: number;
  /** Fills before this time are already accounted for. */
  fillCursor: number;
  stats: EngineStats;
  /** Total volume when the current run started (a run ends with a stop). */
  runStartVolume?: string | undefined;
  /** Realised PnL − fees when the current run started: risk.maxLoss counts from here. */
  runStartPnl?: string | undefined;
  /** Keys of the latest one-shot orders placed (DesiredOrder.once): never placed again. */
  sentOnce?: string[] | undefined;
}

/** One-shot keys remembered (strategies use a new key each time, so only recent ones matter). */
const SENT_ONCE_KEPT = 100;

/** Volume-farming metrics, kept over the bot's lifetime. */
export interface EngineStats {
  /** Orders sent: each placed, cancelled or replaced order counts as one address action. */
  actions: number;
  makerVolume: string;
  takerVolume: string;
}

/** PnL samples keep minute detail this long (then one an hour). */
const SAMPLE_MINUTES_KEPT_MS = 3 * 86_400_000;

const emptyStats = (): EngineStats => ({ actions: 0, makerVolume: "0", takerVolume: "0" });

export interface BotSummary {
  status: BotStatus;
  statusReason?: string | undefined;
  mark?: string | undefined;
  position: PositionState;
  unrealizedPnl: string;
  totalPnl: string;
  activeOrders: number;
  stats: EngineStats;
  /** Cost per $1M of volume: −total PnL ÷ volume × 1,000,000 (negative = the bot made money). */
  costPerMillion?: string | undefined;
  /** Last known address action budget. */
  actionBudget?: { remaining: number; quota: number } | undefined;
}

/**
 * Runs one bot: feeds exchange events to the strategy, keeps the exchange's
 * orders in line with what the strategy wants, persists everything, and
 * recovers after restarts. All work happens inside `cycle()` and
 * `reconcile()`, which never overlap, so state changes are serialised.
 */
export class BotEngine<C, S> {
  readonly bot: BotRecord;
  readonly #strategy: Strategy<C, S>;
  readonly #config: C;
  readonly #ex: ExchangeAdapter;
  readonly #store: SqliteStore;
  readonly #risk: RiskLimits;
  readonly #onEvent: EngineOptions<C, S>["onEvent"];
  readonly #batchSize: number;
  readonly #prefix: string;
  readonly #ctx: StrategyContext<C>;

  #status: BotStatus;
  #statusReason: string | undefined;
  #state!: EngineState;
  #strategyState!: S;
  #queue: (MarketEvent | AccountEvent | { type: "resync" })[] = [];
  #busy: Promise<void> | undefined;
  #mark: string | undefined;
  #book: BookTop | undefined;
  /** Perps: the latest index price (outside exchanges), when the feed sends it. */
  #index: string | undefined;
  #lastDataAt = 0;
  #lastReconnectAt = 0;
  /** Quotes were pulled because the feed went quiet; say so when it's back. */
  #pulledForStale = false;
  /** When to look up orders whose outcome is unknown (a request that got no answer). */
  #recheckAt: number | undefined;
  #consecutiveRejects = 0;
  #lastRejectError: string | undefined;
  readonly #deadManShared: (() => boolean) | undefined;
  #driftStrikes = 0;
  /** When the current position mismatch was first seen. */
  #driftSince: number | undefined;
  /** Paused for a position mismatch: resumes by itself once SoDEX agrees again. */
  #driftPaused = false;
  #stopRequest: { reason: string; closePosition: boolean } | undefined;
  /** Open orders on this market that aren't this bot's, at the last account check. */
  #otherOrders = 0;
  readonly #stopWhenPausedMs: number | undefined;
  /** When the bot was paused (a restart while paused starts the clock again). */
  #pausedAt: number | undefined;
  #takerRetry = new Set<string>();
  #warned = new Set<string>();
  #deadManArmedAt = 0;
  #actionBudget: { remaining: number; quota: number } | undefined;
  #wake: (() => void) | undefined;

  constructor(options: EngineOptions<C, S>) {
    this.bot = options.bot;
    this.#strategy = options.strategy;
    this.#config = options.config;
    this.#ex = options.exchange;
    this.#store = options.store;
    // Quoting needs fresher data than resting strategies (spec: 3 s), and pulls its
    // quotes when the feed goes quiet: a quote left at an old price gets picked off.
    const quotingDefaults = options.strategy.quoting
      ? { staleDataMs: 3_000, stalePullMs: 5_000, staleReconnectMs: 10_000 }
      : {};
    this.#risk = { ...DEFAULT_RISK, ...quotingDefaults, ...options.risk };
    this.#onEvent = options.onEvent;
    this.#deadManShared = options.deadManShared;
    this.#batchSize = options.batchSize ?? 20;
    this.#stopWhenPausedMs = options.stopWhenPausedMs;
    this.#prefix = botOrderPrefix(options.strategy.idPrefix, options.bot.id);
    this.#status = options.bot.status;
    this.#statusReason = options.bot.statusReason;

    this.#ctx = {
      config: this.#config,
      symbol: this.#ex.symbol,
      market: this.#ex.market,
      mode: this.#ex.mode,
      now: () => this.#ex.now(),
      mark: () => this.#mark,
      book: () => this.#book,
      index: () => this.#index,
      position: () => this.#state.position.size,
      totalPnl: () => totalPnl(this.#state.position, this.#mark),
      volume: () => this.#state.position.volume,
      runVolume: () =>
        canonicalDecimal(
          toDecimal(this.#state.position.volume).minus(this.#state.runStartVolume ?? "0"),
        ),
      actions: () => this.#state.stats.actions,
      otherOrders: () => this.#otherOrders,
      log: (level, message, data) => this.#log(level, "strategy", message, data),
      requestStop: (reason, opts) => {
        this.#stopRequest ??= { reason, closePosition: opts.closePosition };
      },
    };
  }

  get status(): BotStatus {
    return this.#status;
  }

  get orderPrefix(): string {
    return this.#prefix;
  }

  /** Strategy state, for status displays and tests. */
  get strategyState(): S {
    return this.#strategyState;
  }

  summary(): BotSummary {
    return {
      status: this.#status,
      statusReason: this.#statusReason,
      mark: this.#mark,
      position: this.#state.position,
      unrealizedPnl: unrealizedPnl(this.#state.position, this.#mark),
      totalPnl: totalPnl(this.#state.position, this.#mark),
      activeOrders: this.#store.activeOrders(this.bot.id).length,
      stats: this.#state.stats,
      costPerMillion: costPerMillion(this.#state.position, this.#mark),
      actionBudget: this.#actionBudget,
    };
  }

  /** Called whenever an event is queued, so a runner can cycle right away instead of on a timer. */
  setWakeHandler(wake: (() => void) | undefined): void {
    this.#wake = wake;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Connect, restore state, catch up on anything missed while offline, then run. */
  async start(): Promise<void> {
    const restartAfterStop = this.#status === "stopped";
    this.#setStatus("starting", undefined);
    await this.attach();

    // A stopped bot starts a fresh run (new strategy state, setup again) from a flat
    // position: a new layout can't take over leftover inventory, so close it first.
    if (restartAfterStop) {
      if (!toDecimal(this.#state.position.size).isZero()) await this.#matchAccountPosition();
      if (!toDecimal(this.#state.position.size).isZero()) {
        this.#log(
          "warn",
          "close-leftover",
          `The last run left a position of ${this.#state.position.size} open; closing it at market before starting`,
        );
        const placed = await this.#closePosition();
        for (let i = 0; placed && i < 10 && !toDecimal(this.#state.position.size).isZero(); i++) {
          await this.#reconcileUnlocked();
          if (!toDecimal(this.#state.position.size).isZero())
            await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (!toDecimal(this.#state.position.size).isZero()) {
        const message = `Couldn't close the ${this.#state.position.size} position left from the last run, so the bot didn't start. Close it on sodex.com, or start a bot with a new name.`;
        this.#log("error", "position-open", message);
        this.#setStatus("stopped", "position still open");
        await this.#ex.stop();
        throw new Error(message);
      }
      this.#strategyState = this.#strategy.initialState(this.#ctx);
      // A fresh strategy numbers its one-shot orders from the start again (Taker Volume:
      // T1, T2, …). Kept from the last run, those keys would be skipped as already sent.
      this.#state.sentOnce = undefined;
      this.#state.setupDone = false;
      this.#state.runStartVolume = undefined;
      this.#state.runStartPnl = undefined;
      this.#log("info", "new-run", "Starting a new run (the previous run was stopped)");
    }
    // A new run counts its volume and loss from here (a restart after a reboot continues
    // the run). It starts flat, so realised PnL − fees is all there is.
    this.#state.runStartVolume ??= this.#state.position.volume;
    this.#state.runStartPnl ??= canonicalDecimal(
      toDecimal(this.#state.position.realizedPnl).minus(this.#state.position.fees),
    );

    if (!this.#state.setupDone) {
      const setup = this.#strategy.setup?.(this.#ctx);
      if (setup?.leverage !== undefined && this.#ex.setLeverage) {
        let leverage = setup.leverage;
        if (this.#risk.maxLeverage !== undefined && leverage > this.#risk.maxLeverage) {
          this.#log(
            "warn",
            "leverage-capped",
            `Strategy asked for ${leverage}x; capped at risk.maxLeverage ${this.#risk.maxLeverage}x`,
          );
          leverage = this.#risk.maxLeverage;
        }
        await this.#setLeverage(leverage, setup.marginMode ?? "CROSS");
      }
      this.#state.setupDone = true;
    }

    if (this.#status === "starting") this.#setStatus("running", undefined);
    this.#persist();
    await this.cycle();
  }

  /**
   * Restore saved state, connect to the exchange and reconcile, without placing
   * anything. Used on its own by `stop`/`status`, and as the first half of `start`.
   */
  async attach(): Promise<void> {
    const now = this.#ex.now();
    this.#state = this.#store.getKV<EngineState>(this.bot.id, "engine") ?? {
      seq: 0,
      position: emptyPosition(),
      setupDone: false,
      startedAt: now,
      fillCursor: now,
      stats: emptyStats(),
    };
    this.#state.stats ??= emptyStats();
    const saved = this.#store.getKV<S>(this.bot.id, "strategy");
    const resuming = saved !== undefined;
    this.#strategyState = saved ?? this.#strategy.initialState(this.#ctx);
    if (!resuming) this.#state.sentOnce = undefined;

    await this.#ex.start({
      onMarket: (e) => this.#enqueue(e),
      onAccount: (e) => this.#enqueue(e),
      onResync: () => this.#enqueue({ type: "resync" }),
      onWarning: (message) => this.#log("warn", "exchange", message),
    });

    if (resuming) {
      this.#log(
        "info",
        "resume",
        `Resuming; catching up from ${new Date(this.#state.fillCursor).toISOString()}`,
      );
    }
    await this.reconcile();
  }

  /**
   * Disconnect (Ctrl+C). Resting strategies leave their orders on the book;
   * quoting strategies cancel theirs first and clear the dead-man switch.
   */
  async detach(): Promise<void> {
    if (this.#strategy.quoting && this.#status !== "stopped") {
      await this.#exclusive(async () => {
        await this.#cancelEverything();
        await this.#clearDeadMan();
      });
      this.#log("info", "detach", "Quotes cancelled on disconnect");
    } else {
      await this.#busy;
    }
    this.#persist();
    await this.#ex.stop();
  }

  pause(reason: string): void {
    this.#driftPaused = false;
    if (this.#status === "running" || this.#status === "starting") {
      this.#setStatus("paused", reason);
      this.#log("warn", "paused", `Paused: ${reason}`);
    }
  }

  resume(): void {
    this.#driftPaused = false;
    if (this.#status === "paused") {
      this.#consecutiveRejects = 0;
      this.#setStatus("running", undefined);
      this.#log("info", "resumed", "Resumed");
    }
  }

  /** Cancel every order of this bot and optionally close its position, then mark it stopped. */
  async stop(options: { closePosition: boolean; reason?: string }): Promise<void> {
    await this.#exclusive(async () => {
      this.#setStatus("stopping", options.reason);
      this.#log(
        "info",
        "stopping",
        `Stopping (${options.closePosition ? "cancel + close" : "cancel only"})${options.reason ? `: ${options.reason}` : ""}`,
      );
      await this.#cancelEverything();
      await this.#clearDeadMan();
      if (options.closePosition) await this.#closePosition();
      this.#setStatus("stopped", options.reason);
      this.#persist();
    });
  }

  // ── Event intake ────────────────────────────────────────────────────────────

  #enqueue(event: MarketEvent | AccountEvent | { type: "resync" }): void {
    this.#queue.push(event);
    this.#wake?.();
  }

  get hasPendingEvents(): boolean {
    return this.#queue.length > 0;
  }

  /** Process queued events, then bring the exchange in line with the strategy. */
  async cycle(): Promise<void> {
    await this.#exclusive(async () => {
      let resync = false;
      for (const event of this.#queue.splice(0)) {
        if (event.type === "resync") resync = true;
        else if (event.type === "fill") this.#handleFill(event.fill);
        else if (event.type === "order") await this.#handleOrderEvent(event);
        else this.#handleMarket(event);
      }
      if (resync) {
        await this.#reconcileUnlocked();
        this.#recheckAt = undefined;
      }
      this.#watchFeed();
      if (this.#recheckAt !== undefined && this.#ex.now() >= this.#recheckAt) {
        // Retried on the next cycle if the exchange is still unreachable.
        this.#recheckAt = this.#ex.now() + this.#risk.unknownRecheckMs;
        await this.#reconcileUnlocked();
        this.#recheckAt = undefined;
      }
      this.#checkLossLimit();
      this.#stopIfPausedTooLong();
      if (this.#stopRequest) {
        const { reason, closePosition } = this.#stopRequest;
        this.#stopRequest = undefined;
        this.#setStatus("stopping", reason);
        this.#log("warn", "stop-requested", `Stopping: ${reason}`);
        await this.#cancelEverything();
        await this.#clearDeadMan();
        if (closePosition) await this.#closePosition();
        this.#setStatus("stopped", reason);
      } else if (this.#status === "running") {
        await this.#armDeadMan();
        await this.#syncOrders();
      } else if (
        this.#status === "paused" &&
        this.#strategy.quoting &&
        this.#store.activeOrders(this.bot.id).length > 0
      ) {
        await this.#cancelEverything();
        this.#log("info", "paused-cancel", "Quotes cancelled while paused");
      }
      this.#persist();
      this.#sample();
    });
  }

  /** Milliseconds since the last market data (0 before the first). */
  #staleFor(): number {
    return this.#lastDataAt === 0 ? 0 : this.#ex.now() - this.#lastDataAt;
  }

  /** A silent feed is usually a dead connection the socket hasn't noticed yet: reconnect. */
  #watchFeed(): void {
    const quiet = this.#staleFor();
    const now = this.#ex.now();
    if (
      this.#ex.reconnect &&
      quiet > this.#risk.staleReconnectMs &&
      now - this.#lastReconnectAt > this.#risk.staleReconnectMs
    ) {
      this.#lastReconnectAt = now;
      this.#log(
        "warn",
        "feed-reconnect",
        `No prices for ${Math.round(quiet / 1000)} s; reconnecting the price feed`,
      );
      this.#ex.reconnect();
    }
  }

  /** Compare with the exchange's view: order states, missed fills, orphans and position drift. */
  async reconcile(): Promise<void> {
    await this.#exclusive(() => this.#reconcileUnlocked());
  }

  async #exclusive(fn: () => Promise<void>): Promise<void> {
    while (this.#busy) await this.#busy;
    const run = fn().finally(() => {
      this.#busy = undefined;
    });
    this.#busy = run;
    await run;
  }

  #handleMarket(event: MarketEvent): void {
    // Another exchange's price: for the strategy only. It says nothing about SoDEX's feed,
    // so it must not keep a dead SoDEX feed looking alive.
    if (event.type === "ref") {
      this.#strategy.onMarket?.(this.#ctx, this.#strategyState, event);
      return;
    }
    if (event.type === "mark") {
      this.#mark = event.price;
      if (event.index !== undefined) this.#index = event.index;
    }
    if (event.type === "book") {
      this.#book = {
        bid: event.bid,
        ask: event.ask,
        ...(event.bidSize !== undefined ? { bidSize: event.bidSize } : {}),
        ...(event.askSize !== undefined ? { askSize: event.askSize } : {}),
      };
      if (this.#ex.market === "spot") {
        this.#mark = canonicalDecimal(toDecimal(event.bid).plus(event.ask).div(2));
      }
    }
    this.#lastDataAt = event.time;
    this.#strategy.onMarket?.(this.#ctx, this.#strategyState, event);
  }

  #handleFill(fill: Fill): void {
    if (!fill.clOrdID.startsWith(this.#prefix)) return;
    if (!this.#store.addFill(this.bot.id, fill)) {
      // Already seen. Spot: the WebSocket copy has no fee coin; the REST copy does.
      const seen = this.#store.getFill(this.bot.id, fill.tradeId);
      if (seen && seen.feeCoin === undefined && fill.feeCoin !== undefined) {
        this.#state.position = correctFeeCoin(this.#state.position, seen, fill, this.#baseCoin());
        this.#store.updateFill(this.bot.id, { ...seen, feeCoin: fill.feeCoin });
      }
      return;
    }

    this.#state.position = applyFill(this.#state.position, fill, this.#baseCoin());
    this.#state.fillCursor = Math.max(this.#state.fillCursor, fill.time);
    const notional = toDecimal(fill.price).mul(fill.quantity);
    const stats = this.#state.stats;
    if (fill.isMaker)
      stats.makerVolume = canonicalDecimal(toDecimal(stats.makerVolume).plus(notional));
    else stats.takerVolume = canonicalDecimal(toDecimal(stats.takerVolume).plus(notional));

    const order = this.#store.getOrder(this.bot.id, fill.clOrdID);
    if (!order) {
      this.#log("warn", "fill-unknown-order", `Fill for untracked order ${fill.clOrdID}`, fill);
      return;
    }
    order.filledQty = canonicalDecimal(toDecimal(order.filledQty).plus(fill.quantity));
    order.orderId ??= fill.orderId;
    if (order.quantity !== undefined && toDecimal(order.filledQty).gte(order.quantity)) {
      order.status = "filled";
    } else if (!CLOSED_STATUSES.has(order.status)) {
      order.status = "partially_filled";
    }
    order.updatedAt = this.#ex.now();
    this.#store.saveOrder(this.bot.id, order);
    this.#log(
      "info",
      "fill",
      `${fill.side} ${fill.quantity} @ ${fill.price} (${order.key}), fee ${fill.fee}`,
    );
    this.#strategy.onFill?.(this.#ctx, this.#strategyState, fill, order);
  }

  async #handleOrderEvent(event: Extract<AccountEvent, { type: "order" }>): Promise<void> {
    if (!event.clOrdID.startsWith(this.#prefix)) return;
    const order = this.#store.getOrder(this.bot.id, event.clOrdID);
    if (!order) return;
    this.#applyExchangeStatus(order, event.status, event.orderId, event.reason);
  }

  #applyExchangeStatus(
    order: TrackedOrder,
    status: ExchangeOrder["status"],
    orderId: string | undefined,
    reason: string | undefined,
  ): void {
    const wasClosed = CLOSED_STATUSES.has(order.status);
    order.orderId ??= orderId;
    if (status === "open" || status === "partially_filled") {
      if (order.status === "cancelling") return; // our cancel is in flight
      order.status = status;
    } else {
      order.status = status;
      if (reason) order.error = reason;
    }
    order.updatedAt = this.#ex.now();
    this.#store.saveOrder(this.bot.id, order);

    if (!wasClosed && CLOSED_STATUSES.has(order.status)) this.#onClosed(order);
  }

  #onClosed(order: TrackedOrder): void {
    const unfilled = toDecimal(order.filledQty).isZero();
    if ((order.status === "expired" || order.status === "rejected") && order.postOnly && unfilled) {
      if (order.takerFallback) {
        this.#takerRetry.add(order.key);
        this.#log(
          "info",
          "post-only-crossed",
          `Post-only ${order.key} would have crossed; re-sending as taker`,
        );
      }
    }
    if (order.status !== "filled")
      this.#strategy.onOrderClosed?.(this.#ctx, this.#strategyState, order);
  }

  // ── Keeping the book in line with the strategy ─────────────────────────────

  async #syncOrders(): Promise<void> {
    let desired = this.#strategy.desired(this.#ctx, this.#strategyState);
    const quiet = this.#staleFor();
    if (this.#strategy.quoting && quiet > this.#risk.stalePullMs) {
      if (!this.#pulledForStale) {
        this.#pulledForStale = true;
        this.#log(
          "warn",
          "feed-quiet",
          `No prices for ${Math.round(quiet / 1000)} s; quotes pulled until the price feed is back`,
        );
      }
      desired = [];
    } else if (this.#pulledForStale && quiet <= this.#risk.staleDataMs) {
      this.#pulledForStale = false;
      this.#log("info", "feed-back", "Price feed is back; quoting again");
    }
    if (this.#strategy.quoting && this.#budgetLow()) {
      this.#warnOnce(
        "budget",
        `Only ${this.#actionBudget?.remaining} address actions left (keeping ${this.#risk.minActionBudget} in reserve); quoting paused until volume earns more`,
      );
      desired = [];
    } else {
      this.#warned.delete("budget");
    }
    const active = this.#store.activeOrders(this.bot.id);
    const diff = diffOrders(desired, active, { canReplace: Boolean(this.#ex.replace) });
    // A one-shot order already sent is never sent again, even once it has closed.
    const sentOnce = new Set(this.#state.sentOnce ?? []);
    diff.place = diff.place.filter((w) => !(w.once && sentOnce.has(w.key)));

    if (diff.cancel.length > 0) await this.#cancel(diff.cancel);

    const stale = this.#ex.now() - this.#lastDataAt > this.#risk.staleDataMs;
    if (diff.place.length === 0 && diff.replace.length === 0) return;
    if (stale) {
      this.#warnOnce(
        "stale",
        `No market data for ${Math.round((this.#ex.now() - this.#lastDataAt) / 1000)} s; holding new orders`,
      );
      return;
    }
    this.#warned.delete("stale");

    // Risk is checked as if the replaced orders were already gone.
    const replacedOrders = new Set(diff.replace.map((r) => r.order));
    const keep = active.filter((o) => !diff.cancel.includes(o) && !replacedOrders.has(o));
    const allowed = new Set(
      this.#withinRisk([...diff.replace.map((r) => r.want), ...diff.place], keep),
    );
    const toReplace = diff.replace.filter((r) => allowed.has(r.want));
    const toPlace = diff.place.filter((w) => allowed.has(w));
    if (toReplace.length > 0) await this.#replace(toReplace);
    if (toPlace.length > 0) await this.#place(toPlace);
  }

  /** Move live orders to new terms with SoDEX's atomic replace (one action, no empty moment). */
  async #replace(items: { order: TrackedOrder; want: DesiredOrder }[]): Promise<void> {
    const replace = this.#ex.replace;
    if (!replace) return;
    const now = this.#ex.now();
    const pairs = items.map(({ order, want }) => {
      this.#state.seq += 1;
      const next: TrackedOrder = {
        ...order,
        clOrdID: clOrdId(this.#strategy.idPrefix, this.bot.id, this.#state.seq),
        price: want.price,
        quantity: want.quantity,
        filledQty: "0",
        orderId: undefined,
        error: undefined,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      return { old: order, next };
    });
    this.#store.transaction(() => {
      for (const { next } of pairs) this.#store.saveOrder(this.bot.id, next);
      this.#store.setKV(this.bot.id, "engine", this.#state);
    });

    for (let i = 0; i < pairs.length; i += this.#batchSize) {
      const batch = pairs.slice(i, i + this.#batchSize);
      const requests: ReplaceRequest[] = batch.map(({ old, next }) => ({
        origClOrdID: old.clOrdID,
        clOrdID: next.clOrdID,
        price: next.price,
        quantity: next.quantity,
      }));
      this.#state.stats.actions += batch.length;
      const results = await replace.call(this.#ex, requests);
      for (const { old, next } of batch) {
        const r = results.find((x) => x.clOrdID === next.clOrdID);
        const fresh = this.#store.getOrder(this.bot.id, next.clOrdID) ?? next;
        const oldFresh = this.#store.getOrder(this.bot.id, old.clOrdID) ?? old;
        if (!r || r.unknown) {
          // Either could be live: reconcile settles it.
          fresh.status = "unknown";
          this.#recheckSoon();
          fresh.error = r?.error ?? "no result";
          if (!CLOSED_STATUSES.has(oldFresh.status)) oldFresh.status = "cancelling";
        } else if (r.ok) {
          if (fresh.status === "pending") fresh.status = "open";
          fresh.orderId ??= r.orderId;
          if (!CLOSED_STATUSES.has(oldFresh.status)) {
            oldFresh.status = "canceled";
            oldFresh.error = `replaced by ${next.clOrdID}`;
          }
          this.#consecutiveRejects = 0;
        } else if (/OrderNotFound/i.test(r.error ?? "")) {
          // A race, not a fault: the quote filled (or was cancelled) just before the
          // move arrived. Its fill comes through the account stream or the next
          // reconcile, so this doesn't count towards the reject limit.
          fresh.status = "rejected";
          fresh.error = r.error;
          // Stop moving it: the key waits until a reconcile, due shortly, says whether it
          // filled or was cancelled. Retrying every cycle kept the order looking fresh,
          // so reconcile never judged it and the bot quoted nothing (2026-11-01).
          if (!CLOSED_STATUSES.has(oldFresh.status)) oldFresh.status = "cancelling";
          this.#recheckSoon();
          this.#log("info", "replace-raced", `${old.key} filled or closed before it could move`);
        } else {
          // The original order is untouched when a replace is rejected.
          fresh.status = "rejected";
          fresh.error = r.error;
          this.#consecutiveRejects += 1;
          this.#lastRejectError = r.error;
          this.#log(
            "warn",
            "replace-rejected",
            `Moving ${old.key} to ${next.price} rejected: ${r.error}`,
          );
        }
        fresh.updatedAt = oldFresh.updatedAt = this.#ex.now();
        this.#store.saveOrder(this.bot.id, oldFresh);
        this.#store.saveOrder(this.bot.id, fresh);
      }
    }
    if (this.#consecutiveRejects >= this.#risk.maxConsecutiveRejects) {
      this.pause(
        `${this.#consecutiveRejects} orders rejected in a row${rejectReason(this.#lastRejectError)}`,
      );
    }
  }

  #budgetLow(): boolean {
    return (
      this.#actionBudget !== undefined && this.#actionBudget.remaining < this.#risk.minActionBudget
    );
  }

  /** When arming the dead-man switch last failed with a warning (one a minute while SoDEX is down). */
  #deadManWarnedAt = 0;

  /** Quoting strategies: keep the exchange dead-man switch armed ahead of now. */
  async #armDeadMan(): Promise<void> {
    if (!this.#strategy.quoting || !this.#ex.scheduleCancel) return;
    const now = this.#ex.now();
    if (now - this.#deadManArmedAt < this.#risk.deadManMs / 3) return;
    try {
      await this.#ex.scheduleCancel(now + this.#risk.deadManMs);
      this.#deadManArmedAt = now;
      this.#deadManWarnedAt = 0;
    } catch (error) {
      // Retried every cycle; while SoDEX can't be reached, say so once a minute.
      if (now - this.#deadManWarnedAt < 60_000) return;
      this.#deadManWarnedAt = now;
      this.#log(
        "warn",
        "dead-man",
        `Could not arm the dead-man switch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #clearDeadMan(): Promise<void> {
    if (!this.#strategy.quoting || !this.#ex.scheduleCancel || this.#deadManArmedAt === 0) return;
    if (this.#deadManShared?.()) {
      // Another bot keeps re-arming it; our own orders are already cancelled.
      this.#deadManArmedAt = 0;
      return;
    }
    try {
      await this.#ex.scheduleCancel(undefined);
      this.#deadManArmedAt = 0;
    } catch {
      // It will simply fire on schedule; our orders are already cancelled.
    }
  }

  /**
   * risk.maxLoss: stop and close once this run's PnL (realised + unrealised − fees, since
   * the run started) reaches −maxLoss. Earlier runs don't count: a new start gets the full limit.
   */
  #checkLossLimit(): void {
    if (this.#risk.maxLoss === undefined || this.#status !== "running" || this.#stopRequest) return;
    const pnl = toDecimal(totalPnl(this.#state.position, this.#mark)).minus(
      this.#state.runStartPnl ?? "0",
    );
    if (pnl.lte(toDecimal(this.#risk.maxLoss).neg())) {
      this.#log(
        "error",
        "max-loss",
        `This run's PnL ${pnl.toFixed(4)} reached risk.maxLoss −${this.#risk.maxLoss}`,
      );
      this.#stopRequest = {
        reason: `max loss reached (PnL ${pnl.toFixed(2)})`,
        closePosition: true,
      };
    }
  }

  /** Drop orders that fail exchange filters or would break the bot's risk limits. */
  #withinRisk(candidates: DesiredOrder[], keep: TrackedOrder[]): DesiredOrder[] {
    const symbol = this.#ex.symbol;
    const mark = this.#mark;
    const ok: DesiredOrder[] = [];
    const position = toDecimal(this.#state.position.size);

    // Worst case on each side if every resting order that adds risk were filled.
    // On spot a sell only reduces holdings, so only buys add risk.
    const addsRisk = (side: "BUY" | "SELL") => side === "BUY" || this.#ex.market === "perps";
    const markPrice = mark ? toDecimal(mark) : toDecimal(0);
    const side = {
      BUY: {
        size: position.gt(0) ? position : toDecimal(0),
        notional: position.gt(0) ? position.mul(markPrice) : toDecimal(0),
      },
      SELL: {
        size: position.lt(0) ? position.abs() : toDecimal(0),
        notional: position.lt(0) ? position.abs().mul(markPrice) : toDecimal(0),
      },
    };
    for (const o of keep) {
      if (o.kind === "limit" && !o.reduceOnly && o.price && o.quantity && addsRisk(o.side)) {
        const remaining = toDecimal(o.quantity).minus(o.filledQty);
        side[o.side].size = side[o.side].size.plus(remaining);
        side[o.side].notional = side[o.side].notional.plus(toDecimal(o.price).mul(remaining));
      }
    }
    let openOrders = keep.length;

    for (const want of candidates) {
      if (this.#risk.maxOpenOrders !== undefined && openOrders >= this.#risk.maxOpenOrders) {
        this.#warnOnce(
          `count-${want.key}`,
          `Order ${want.key} skipped: risk.maxOpenOrders ${this.#risk.maxOpenOrders} reached`,
        );
        continue;
      }
      if (want.kind === "limit") {
        if (!want.price || !want.quantity) {
          this.#warnOnce(`bad-${want.key}`, `Order ${want.key} has no price or quantity; skipped`);
          continue;
        }
        const problems = checkOrder(symbol, {
          side: want.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
          type: OrderType.LIMIT,
          price: want.price,
          quantity: want.quantity,
          reduceOnly: Boolean(want.reduceOnly),
          ...(this.#ex.market === "perps" && mark ? { markPrice: mark } : {}),
        });
        if (problems.length > 0) {
          this.#warnOnce(`filter-${want.key}`, `Order ${want.key} skipped: ${problems.join("; ")}`);
          continue;
        }
        if (!want.reduceOnly && addsRisk(want.side)) {
          const current = side[want.side];
          const nextNotional = current.notional.plus(toDecimal(want.price).mul(want.quantity));
          const nextSize = current.size.plus(want.quantity);
          const label = want.side === "BUY" ? "long" : "short";
          if (this.#risk.maxNotional !== undefined && nextNotional.gt(this.#risk.maxNotional)) {
            this.#warnOnce(
              `cap-${want.key}`,
              `Order ${want.key} skipped: ${label} exposure could reach ${nextNotional.toFixed(2)} > risk.maxNotional ${this.#risk.maxNotional}`,
            );
            continue;
          }
          if (this.#risk.maxPosition !== undefined && nextSize.gt(this.#risk.maxPosition)) {
            this.#warnOnce(
              `cap-${want.key}`,
              `Order ${want.key} skipped: ${label} position could reach ${nextSize.toFixed()} > risk.maxPosition ${this.#risk.maxPosition}`,
            );
            continue;
          }
          current.notional = nextNotional;
          current.size = nextSize;
        }
      }
      openOrders += 1;
      this.#warned.delete(`filter-${want.key}`);
      this.#warned.delete(`cap-${want.key}`);
      this.#warned.delete(`count-${want.key}`);
      ok.push(want);
    }
    return ok;
  }

  async #place(wanted: DesiredOrder[]): Promise<void> {
    const now = this.#ex.now();
    const orders: TrackedOrder[] = wanted.map((w) => {
      const asTaker = w.kind === "limit" && this.#takerRetry.has(w.key);
      this.#takerRetry.delete(w.key);
      this.#state.seq += 1;
      return {
        clOrdID: clOrdId(this.#strategy.idPrefix, this.bot.id, this.#state.seq),
        key: w.key,
        side: w.side,
        kind: w.kind,
        price: w.price,
        quantity: w.quantity,
        filledQty: "0",
        postOnly: w.kind === "limit" && !asTaker && !w.ioc && w.postOnly !== false,
        takerFallback: w.onPostOnlyReject === "taker",
        ioc: w.ioc,
        reduceOnly: Boolean(w.reduceOnly),
        stopPrice: w.stopPrice,
        stopType: w.stopType,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    });
    const once = wanted.filter((w) => w.once).map((w) => w.key);
    if (once.length > 0) {
      this.#state.sentOnce = [...(this.#state.sentOnce ?? []), ...once].slice(-SENT_ONCE_KEPT);
    }
    // Persist before sending so a crash mid-request can't lose track of an order.
    this.#store.transaction(() => {
      for (const o of orders) this.#store.saveOrder(this.bot.id, o);
      this.#store.setKV(this.bot.id, "engine", this.#state);
    });

    for (let i = 0; i < orders.length; i += this.#batchSize) {
      const batch = orders.slice(i, i + this.#batchSize);
      this.#state.stats.actions += batch.length;
      const results = await this.#ex.place(batch.map(toPlaceRequest));
      for (const order of batch) {
        const r = results.find((x) => x.clOrdID === order.clOrdID);
        if (order.status !== "pending") continue; // already updated by a synchronous event
        if (!r || r.unknown) {
          order.status = "unknown";
          order.error = r?.error ?? "no result";
          this.#recheckSoon();
          this.#log("warn", "place-unknown", `Outcome of ${order.clOrdID} unknown; will reconcile`);
        } else if (r.ok) {
          order.status = "open";
          order.orderId = r.orderId;
          this.#consecutiveRejects = 0;
        } else {
          order.status = "rejected";
          order.error = r.error;
          this.#consecutiveRejects += 1;
          this.#lastRejectError = r.error;
          this.#log(
            "warn",
            "rejected",
            `${order.key} ${order.side} ${order.quantity ?? ""} @ ${order.price ?? order.stopPrice ?? "market"} rejected: ${r.error}`,
          );
        }
        order.updatedAt = this.#ex.now();
        this.#store.saveOrder(this.bot.id, order);
        if (order.status === "rejected") this.#onClosed(order);
      }
    }

    const placed = orders.filter(
      (o) => o.status === "open" || o.status === "filled" || o.status === "partially_filled",
    );
    if (placed.length > 0) this.#log("info", "placed", `Placed ${describeOrders(placed)}`);

    if (this.#consecutiveRejects >= this.#risk.maxConsecutiveRejects) {
      this.pause(
        `${this.#consecutiveRejects} orders rejected in a row${rejectReason(this.#lastRejectError)}`,
      );
    }
  }

  async #cancel(orders: TrackedOrder[]): Promise<void> {
    for (const o of orders) {
      o.status = "cancelling";
      o.updatedAt = this.#ex.now();
      this.#store.saveOrder(this.bot.id, o);
    }
    for (let i = 0; i < orders.length; i += this.#batchSize) {
      const batch = orders.slice(i, i + this.#batchSize);
      this.#state.stats.actions += batch.length;
      const results = await this.#ex.cancel(batch.map((o) => o.clOrdID));
      for (const order of batch) {
        const fresh = this.#store.getOrder(this.bot.id, order.clOrdID) ?? order;
        if (fresh.status !== "cancelling") continue; // closed by an event meanwhile
        const r = results.find((x) => x.clOrdID === order.clOrdID);
        if (r?.ok) {
          fresh.status = "canceled";
          fresh.updatedAt = this.#ex.now();
          this.#store.saveOrder(this.bot.id, fresh);
          this.#onClosed(fresh);
        } else {
          // Leave it "cancelling"; reconcile finds out what really happened.
          fresh.error = r?.error ?? "cancel outcome unknown";
          this.#store.saveOrder(this.bot.id, fresh);
          // Not found: already gone (filled, or a close-position stop SoDEX removed when the
          // position closed). Nothing to warn about; reconcile records which.
          if (!/OrderNotFound/i.test(fresh.error))
            this.#log("warn", "cancel-failed", `Cancel ${order.clOrdID} failed: ${fresh.error}`);
        }
      }
    }
    const done = orders.filter(
      (o) => this.#store.getOrder(this.bot.id, o.clOrdID)?.status === "canceled",
    );
    if (done.length > 0) this.#log("info", "cancelled", `Cancelled ${describeOrders(done)}`);
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────

  async #reconcileUnlocked(): Promise<void> {
    if (this.#ex.actionBudget) {
      try {
        this.#actionBudget = await this.#ex.actionBudget();
        // Saved for status readers (CLI, dashboard API) in other processes.
        this.#store.setKV(this.bot.id, "actionBudget", this.#actionBudget);
      } catch {
        // Keep the last known value.
      }
    }
    const snapshot = await this.#ex.snapshot();
    const now = this.#ex.now();
    this.#otherOrders = snapshot.openOrders.filter(
      (o) => !o.clOrdID?.startsWith(this.#prefix),
    ).length;
    const onExchange = new Map(
      snapshot.openOrders
        .filter((o) => o.clOrdID?.startsWith(this.#prefix))
        .map((o) => [o.clOrdID!, o]),
    );

    // 1. Missed fills (WS gaps, downtime). Applied before order states so fills are never lost.
    const fills = await this.#ex.fillsSince(Math.max(0, this.#state.fillCursor - 60_000));
    for (const fill of fills.sort((a, b) => a.time - b.time)) this.#handleFill(fill);

    // 2. Orders we think are active.
    for (const order of this.#store.activeOrders(this.bot.id)) {
      const live = onExchange.get(order.clOrdID);
      onExchange.delete(order.clOrdID);
      if (live) {
        if (order.status === "cancelling" && now - order.updatedAt > 10_000) {
          order.status = live.status; // cancel never landed; let the diff decide again
          order.updatedAt = now;
          this.#store.saveOrder(this.bot.id, order);
        } else {
          this.#applyExchangeStatus(order, live.status, live.orderId, undefined);
        }
        continue;
      }
      if (now - order.updatedAt < 5_000) continue; // too fresh to judge
      const found = await this.#ex.findOrder(order.clOrdID);
      if (found && found.status !== "open" && found.status !== "partially_filled") {
        this.#applyExchangeStatus(order, found.status, found.orderId, undefined);
      } else if (!found && now - order.updatedAt > this.#risk.historyGraceMs) {
        // Never reached the book (pending/unknown) or vanished without a trace.
        const neverPlaced = order.status === "pending" || order.status === "unknown";
        this.#applyExchangeStatus(
          order,
          neverPlaced ? "rejected" : "canceled",
          undefined,
          neverPlaced ? "not found on exchange" : "missing from exchange",
        );
        if (!neverPlaced)
          this.#log(
            "warn",
            "order-vanished",
            `Order ${order.clOrdID} disappeared from the exchange`,
          );
      }
    }

    // 3. Orphans: our prefix on the exchange but not tracked as active (e.g. crash before saving the result).
    //    An order that filled after the snapshot was taken is not an orphan.
    const orphans = [...onExchange.keys()].filter(
      (id) => this.#store.getOrder(this.bot.id, id)?.status !== "filled",
    );
    if (orphans.length > 0) {
      this.#log(
        "warn",
        "orphans",
        `Cancelling ${orphans.length} untracked order(s) with this bot's prefix`,
      );
      await this.#ex.cancel(orphans);
    }

    // 4. Position drift (perps only: spot balances include coins the bot doesn't manage).
    //    When quoting fast, fills are often in flight: on SoDEX but not yet pushed to
    //    us, pushed but still queued, or not yet in the trade history. So: apply queued
    //    fills, and on a mismatch wait a moment and look again with fresh data. Only a
    //    mismatch that survives that, in two reconciles in a row, pauses the bot.
    if (this.#ex.market === "perps") {
      this.#applyQueuedFills();
      let exchangeSize = snapshot.position.size;
      if (this.#drifted(exchangeSize) && this.#risk.driftRecheckMs >= 0) {
        await new Promise((r) => setTimeout(r, this.#risk.driftRecheckMs));
        const again = await this.#ex.snapshot();
        const late = await this.#ex.fillsSince(Math.max(0, this.#state.fillCursor - 60_000));
        for (const fill of late.sort((a, b) => a.time - b.time)) this.#handleFill(fill);
        this.#applyQueuedFills();
        exchangeSize = again.position.size;
      }
      if (this.#drifted(exchangeSize)) {
        this.#driftStrikes += 1;
        this.#driftSince ??= now;
        const lasting = this.#ex.now() - this.#driftSince >= this.#risk.driftPersistMs;
        if (this.#driftStrikes >= 2 && lasting) {
          const running = this.#status === "running" || this.#status === "starting";
          this.pause(
            `Position drift: exchange ${exchangeSize}, bot expects ${this.#state.position.size}. Was the symbol traded manually?`,
          );
          if (running) this.#driftPaused = true;
        }
      } else {
        this.#driftStrikes = 0;
        this.#driftSince = undefined;
        // SoDEX was running late (seen 2026-11-05 while its blocks were full): carry on.
        if (this.#driftPaused && this.#status === "paused") {
          this.#driftPaused = false;
          this.#setStatus("running", undefined);
          this.#log(
            "info",
            "drift-cleared",
            "Position matches SoDEX again (its account data was running late); trading again",
          );
        }
      }
    }
    this.#persist();
  }

  #drifted(exchangeSize: string): boolean {
    const diff = toDecimal(exchangeSize).minus(this.#state.position.size).abs();
    return diff.gt(toDecimal(this.#ex.symbol.stepSize).div(2));
  }

  /** Apply fills already received but still waiting for the next cycle (they'd be skipped there as duplicates). */
  #applyQueuedFills(): void {
    for (const event of this.#queue) if (event.type === "fill") this.#handleFill(event.fill);
  }

  async #cancelEverything(): Promise<void> {
    const active = this.#store.activeOrders(this.bot.id);
    if (active.length > 0) await this.#cancel(active);
    const snapshot = await this.#ex.snapshot();
    const leftovers = snapshot.openOrders
      .filter((o) => o.clOrdID?.startsWith(this.#prefix))
      .map((o) => o.clOrdID!);
    if (leftovers.length > 0) await this.#ex.cancel(leftovers);
  }

  /**
   * Before closing a leftover position, check what the account really holds on this
   * symbol: it may have been closed on sodex.com (or by another bot on the account).
   * The bot's record keeps at most what's there on its own side; the rest is cleared.
   */
  async #matchAccountPosition(): Promise<void> {
    const own = toDecimal(this.#state.position.size);
    let onAccount;
    try {
      onAccount = toDecimal((await this.#ex.snapshot()).position.size);
    } catch {
      return; // couldn't check: try to close what the bot recorded
    }
    const sameSide = !onAccount.isZero() && onAccount.isNegative() === own.isNegative();
    const keep = !sameSide ? toDecimal(0) : onAccount.abs().lt(own.abs()) ? onAccount : own;
    if (keep.eq(own)) return;
    this.#log(
      "info",
      "position-matched",
      keep.isZero()
        ? `The ${own.toFixed()} position from the last run is no longer on the account (closed outside the bot); starting from flat`
        : `Only ${keep.toFixed()} of the ${own.toFixed()} position from the last run is still on the account; closing that`,
    );
    this.#state.position = {
      ...this.#state.position,
      size: canonicalDecimal(keep),
      avgEntry: keep.isZero() ? "0" : this.#state.position.avgEntry,
    };
    this.#persist();
  }

  /** Market-close the position; false when the order was refused. */
  async #closePosition(): Promise<boolean> {
    let size = toDecimal(this.#state.position.size);
    if (size.isZero()) return true;
    if (this.#ex.market === "spot") {
      // Spot holds coins net of fees, so not on SoDEX's lot grid: sell whole lots, and
      // leave what can't be sold (under one lot, or under the smallest order) in the
      // account. The bot stops counting it, so a new run can start.
      const symbol = this.#ex.symbol;
      const sellable = toDecimal(roundQuantity(symbol, size.gt(0) ? size : 0, "down"));
      const price = this.#book?.bid ?? this.#mark;
      const tooSmall =
        sellable.isZero() || (price !== undefined && sellable.mul(price).lt(symbol.minNotional));
      const left = tooSmall ? size : size.minus(sellable);
      if (!left.isZero()) {
        this.#log(
          "info",
          "dust",
          `${left.toFixed()} ${(symbol as { baseCoin?: string }).baseCoin ?? "coins"} ${tooSmall ? "is" : "of it is"} below SoDEX's smallest sell, so it stays in your spot account`,
        );
        this.#state.position = {
          ...this.#state.position,
          size: canonicalDecimal(size.minus(left)),
          avgEntry: tooSmall ? "0" : this.#state.position.avgEntry,
        };
        this.#persist();
      }
      if (tooSmall) return true;
      size = sellable;
    }
    this.#state.seq += 1;
    const now = this.#ex.now();
    const order: TrackedOrder = {
      clOrdID: clOrdId(this.#strategy.idPrefix, this.bot.id, this.#state.seq),
      key: "close",
      side: size.gt(0) ? "SELL" : "BUY",
      kind: "market",
      quantity: canonicalDecimal(size.abs()),
      filledQty: "0",
      postOnly: false,
      reduceOnly: this.#ex.market === "perps",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.#store.saveOrder(this.bot.id, order);
    const [result] = await this.#ex.place([toPlaceRequest(order)]);
    const fresh = this.#store.getOrder(this.bot.id, order.clOrdID) ?? order;
    if (fresh.status === "pending") {
      fresh.status = result?.ok ? "open" : result?.unknown ? "unknown" : "rejected";
      fresh.error = result?.error;
      this.#store.saveOrder(this.bot.id, fresh);
    }
    this.#log(
      result?.ok ? "info" : "error",
      "close",
      result?.ok
        ? `Closing position ${size.toFixed()} with a market order`
        : `Close order failed: ${result?.error}`,
    );
    return result?.ok === true || result?.unknown === true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  #baseCoin(): string | undefined {
    const s = this.#ex.symbol as { baseCoin?: string };
    return this.#ex.market === "spot" ? s.baseCoin : undefined;
  }

  /**
   * Set leverage and margin mode. SoDEX won't switch a market's margin mode while the account
   * holds a position there (often one opened by hand, or one left in isolated margin): then
   * keep the mode it has for this run instead of failing the start.
   */
  async #setLeverage(leverage: number, mode: "ISOLATED" | "CROSS"): Promise<void> {
    try {
      await this.#ex.setLeverage!(leverage, mode);
      this.#log("info", "setup", `Leverage set to ${leverage}x ${mode}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/margin mode with open positions/i.test(message)) throw error;
    }
    const kept = mode === "CROSS" ? "ISOLATED" : "CROSS";
    const why = `SoDEX won't switch ${this.bot.symbol} to ${mode.toLowerCase()} margin while this account holds a position there, so this run keeps ${kept.toLowerCase()} margin`;
    try {
      await this.#ex.setLeverage!(leverage, kept);
      this.#log("warn", "setup-kept-mode", `${why} (${leverage}x).`);
    } catch {
      this.#log("warn", "setup-kept-mode", `${why} and its current leverage.`);
    }
  }

  /** Paused for longer than stopWhenPausedMs: stop, keep the position, free the bot's place. */
  #stopIfPausedTooLong(): void {
    if (this.#status !== "paused" || this.#stopWhenPausedMs === undefined || this.#stopRequest)
      return;
    const now = this.#ex.now();
    this.#pausedAt ??= now;
    if (now - this.#pausedAt < this.#stopWhenPausedMs) return;
    const minutes = Math.round(this.#stopWhenPausedMs / 60_000);
    this.#stopRequest = {
      reason: `Paused for ${minutes} min, so stopped to free its place: ${this.#statusReason ?? "paused"}. Any position is kept.`,
      closePosition: false,
    };
  }

  #setStatus(status: BotStatus, reason: string | undefined): void {
    if (status === "paused") this.#pausedAt ??= this.#ex.now();
    else this.#pausedAt = undefined;
    this.#status = status;
    this.#statusReason = reason;
    this.#store.setBotStatus(this.bot.id, status, reason, this.#ex.now());
  }

  /** The minute of the last PnL sample, and when old samples were last thinned (ms). */
  #sampledAt = 0;
  #thinnedAt = 0;

  /**
   * One PnL sample a minute (with the strategy's own numbers) for the dashboard's profit
   * chart; after SAMPLE_MINUTES_KEPT_MS only one an hour is kept. Not in backtests.
   */
  #sample(): void {
    if (this.bot.mode === "backtest" || this.#mark === undefined) return;
    const now = this.#ex.now();
    const minute = Math.floor(now / 60_000) * 60_000;
    if (minute === this.#sampledAt) return;
    this.#sampledAt = minute;
    this.#store.addSample(
      this.bot.id,
      minute,
      Number(totalPnl(this.#state.position, this.#mark)),
      this.#strategy.sample?.(this.#strategyState),
    );
    if (now - this.#thinnedAt > 3_600_000) {
      this.#thinnedAt = now;
      this.#store.thinSamples(this.bot.id, now - SAMPLE_MINUTES_KEPT_MS);
    }
  }

  /** What #persist last wrote: most cycles change nothing, and then nothing is written. */
  #persisted: { engine?: string; strategy?: string } = {};

  #persist(): void {
    const engine = JSON.stringify(this.#state);
    const strategy = JSON.stringify(this.#strategyState);
    if (engine === this.#persisted.engine && strategy === this.#persisted.strategy) return;
    this.#store.transaction(() => {
      this.#store.setKVJson(this.bot.id, "engine", engine);
      this.#store.setKVJson(this.bot.id, "strategy", strategy);
    });
    this.#persisted = { engine, strategy };
  }

  #log(level: "info" | "warn" | "error", type: string, message: string, data?: unknown): void {
    this.#store.addEvent(this.bot.id, { time: this.#ex.now(), level, type, message, data });
    this.#onEvent?.({ level, type, message, data });
  }

  #recheckSoon(): void {
    this.#recheckAt ??= this.#ex.now() + this.#risk.unknownRecheckMs;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log("warn", "skipped", message);
  }
}

function costPerMillion(position: PositionState, mark: string | undefined): string | undefined {
  const volume = toDecimal(position.volume);
  if (volume.isZero()) return undefined;
  return canonicalDecimal(
    toDecimal(totalPnl(position, mark)).neg().div(volume).mul(1_000_000).toDecimalPlaces(2),
  );
}

/** "3 orders: L1 BUY 0.0002 @ 76000, L2 …" — capped so big grids don't flood the log. */
function describeOrders(orders: TrackedOrder[]): string {
  const shown = orders
    .slice(0, 4)
    .map(
      (o) => `${o.key} ${o.side} ${o.quantity ?? "all"} @ ${o.price ?? o.stopPrice ?? "market"}`,
    );
  const more = orders.length > 4 ? `, +${orders.length - 4} more` : "";
  return `${orders.length} order(s): ${shown.join(", ")}${more}`;
}

function toPlaceRequest(o: TrackedOrder): PlaceRequest {
  return {
    clOrdID: o.clOrdID,
    side: o.side,
    kind: o.kind,
    price: o.price,
    quantity: o.quantity,
    timeInForce: o.kind === "market" || o.ioc ? "IOC" : o.postOnly ? "GTX" : "GTC",
    reduceOnly: o.reduceOnly,
    stopPrice: o.stopPrice,
    stopType: o.stopType,
  };
}

/** " (insufficient margin)" from "order rejected: insufficient margin". */
function rejectReason(error: string | undefined): string {
  if (!error) return "";
  return ` (${error.replace(/^order rejected:\s*/i, "")})`;
}
