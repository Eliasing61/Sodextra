import type { MarketSymbol } from "@sodextra/sodex-client";

export type Side = "BUY" | "SELL";
export type MarketKind = "perps" | "spot";
export type RunMode = "live" | "paper" | "backtest";

// ── What a strategy asks for ──────────────────────────────────────────────────

/**
 * One order the strategy wants resting on the book. The engine keeps the
 * exchange in sync with the latest list: missing keys get placed, keys that
 * disappear or change get cancelled (and re-placed if still wanted).
 */
export interface DesiredOrder {
  /** Stable slot ID chosen by the strategy, e.g. "L012" for grid line 12. */
  key: string;
  side: Side;
  kind: "limit" | "stop";
  /** Limit price (limit orders). */
  price?: string;
  /** Size. Required for limit orders; omit on a stop to close the whole position. */
  quantity?: string;
  /** Limit orders default to post-only (GTX, maker fee). */
  postOnly?: boolean;
  /**
   * What to do when a post-only order is rejected because it would cross:
   * "taker" re-sends it as a plain GTC limit (fills immediately as taker),
   * "skip" leaves it to the strategy. Default "skip".
   */
  onPostOnlyReject?: "taker" | "skip";
  /** Immediate-or-cancel limit (fills what it can now, cancels the rest). Implies not post-only. */
  ioc?: boolean;
  /**
   * Send at most once: once an order with this key has been placed, the key is never
   * placed again, even after that order closed. For one-shot taker orders, whose "filled"
   * status can arrive before the fill itself: re-sending would trade twice. Keep returning
   * the order while it may still be live, and use a new key for the next one.
   */
  once?: boolean;
  reduceOnly?: boolean;
  /** Stop orders: trigger price (mark price). */
  stopPrice?: string;
  stopType?: "STOP_LOSS" | "TAKE_PROFIT";
}

// ── What the engine tracks ────────────────────────────────────────────────────

export type TrackedStatus =
  | "pending" // sent, no answer yet
  | "open"
  | "partially_filled"
  | "cancelling"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown"; // the request's outcome is unknown; reconcile before acting

export const CLOSED_STATUSES: ReadonlySet<TrackedStatus> = new Set([
  "filled",
  "canceled",
  "rejected",
  "expired",
]);

export interface TrackedOrder {
  clOrdID: string;
  key: string;
  side: Side;
  kind: "limit" | "stop" | "market";
  price?: string | undefined;
  quantity?: string | undefined;
  filledQty: string;
  postOnly: boolean;
  /** Re-send as a plain GTC limit if this post-only order is rejected for crossing. */
  takerFallback?: boolean | undefined;
  /** Immediate-or-cancel limit order. */
  ioc?: boolean | undefined;
  reduceOnly: boolean;
  stopPrice?: string | undefined;
  stopType?: "STOP_LOSS" | "TAKE_PROFIT" | undefined;
  status: TrackedStatus;
  orderId?: string | undefined;
  error?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface Fill {
  /** Exchange trade ID; used to de-duplicate fills seen via WS, polling and recovery. */
  tradeId: string;
  clOrdID: string;
  orderId?: string | undefined;
  side: Side;
  price: string;
  quantity: string;
  /** Total fee in the fee coin (already includes any builder fee). */
  fee: string;
  feeCoin?: string | undefined;
  builderFee?: string | undefined;
  isMaker?: boolean | undefined;
  time: number;
}

// ── What exchanges report ─────────────────────────────────────────────────────

export interface ExchangeOrder {
  clOrdID?: string | undefined;
  orderId: string;
  side: Side;
  kind: "limit" | "stop" | "market";
  price?: string | undefined;
  quantity?: string | undefined;
  filledQty: string;
  status: "open" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";
  reduceOnly: boolean;
  stopPrice?: string | undefined;
}

export interface PositionInfo {
  /** Signed base size: > 0 long, < 0 short. Spot: base coin balance. */
  size: string;
  entryPrice?: string | undefined;
  liquidationPrice?: string | undefined;
  unrealizedPnl?: string | undefined;
}

export interface AccountSnapshot {
  time: number;
  /** Open orders on this bot's symbol. */
  openOrders: ExchangeOrder[];
  position: PositionInfo;
  /** Quote balance available for new orders (USDC). */
  availableQuote: string;
}

/** The best bid and ask, with the size resting at each when the feed sends it. */
export interface BookTop {
  bid: string;
  ask: string;
  bidSize?: string;
  askSize?: string;
}

export type MarketEvent =
  /** Perps: the mark price, and the index (outside exchanges' price) when the feed has it. */
  | { type: "mark"; price: string; index?: string | undefined; time: number }
  /** Best bid and ask, with the size resting at each when the feed has it. */
  | {
      type: "book";
      bid: string;
      ask: string;
      bidSize?: string | undefined;
      askSize?: string | undefined;
      time: number;
    }
  | { type: "trade"; price: string; quantity: string; side: Side; time: number }
  /**
   * The same market's best prices on another exchange (Binance), for strategies that trade
   * on its lead (reference-feed.ts). Strategies only: it doesn't count as SoDEX data.
   */
  | { type: "ref"; bid: string; ask: string; time: number };

export type AccountEvent =
  | { type: "fill"; fill: Fill }
  | {
      type: "order";
      clOrdID: string;
      orderId?: string | undefined;
      status: ExchangeOrder["status"];
      filledQty?: string | undefined;
      reason?: string | undefined;
      time: number;
    };

export interface PlaceRequest {
  clOrdID: string;
  side: Side;
  kind: "limit" | "stop" | "market";
  price?: string | undefined;
  quantity?: string | undefined;
  timeInForce: "GTC" | "GTX" | "IOC";
  reduceOnly: boolean;
  stopPrice?: string | undefined;
  stopType?: "STOP_LOSS" | "TAKE_PROFIT" | undefined;
}

/** Move a resting order to a new price/size in one atomic action. The new order gets `clOrdID`. */
export interface ReplaceRequest {
  origClOrdID: string;
  clOrdID: string;
  price?: string | undefined;
  quantity?: string | undefined;
}

export interface ActionResult {
  clOrdID: string;
  ok: boolean;
  orderId?: string | undefined;
  error?: string | undefined;
  /** Network failure: the request may or may not have been applied. */
  unknown?: boolean | undefined;
}

export interface ExchangeHandlers {
  onMarket(event: MarketEvent): void;
  onAccount(event: AccountEvent): void;
  /** The account stream reconnected; missed events must be recovered from REST. */
  onResync(): void;
  /** Non-fatal adapter problems (stream errors, failed subscriptions). */
  onWarning?(message: string): void;
}

/** Everything the engine needs from an exchange. Live, paper and backtest all implement it. */
export interface ExchangeAdapter {
  readonly mode: RunMode;
  readonly market: MarketKind;
  readonly symbol: MarketSymbol;
  start(handlers: ExchangeHandlers): Promise<void>;
  stop(): Promise<void>;
  now(): number;
  snapshot(): Promise<AccountSnapshot>;
  /** Fills on this symbol at or after `sinceMs`. */
  fillsSince(sinceMs: number): Promise<Fill[]>;
  /** Look an order up by clOrdID in open orders or recent history. */
  findOrder(clOrdID: string): Promise<ExchangeOrder | undefined>;
  place(requests: PlaceRequest[]): Promise<ActionResult[]>;
  cancel(clOrdIDs: string[]): Promise<ActionResult[]>;
  /** Perps only. */
  setLeverage?(leverage: number, marginMode: "ISOLATED" | "CROSS"): Promise<void>;
  /** Atomic replace (SoDEX `replace`). Results are keyed by the NEW clOrdID. */
  replace?(requests: ReplaceRequest[]): Promise<ActionResult[]>;
  /** Dead-man switch: cancel ALL of the account's orders on this engine at `atMs`; undefined clears it. */
  scheduleCancel?(atMs: number | undefined): Promise<void>;
  /** Address action budget (1 action per $1 traded). */
  actionBudget?(): Promise<{ remaining: number; quota: number }>;
  /** Drop the streaming connection and open a new one now (it went silent). */
  reconnect?(): void;
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

export type BotStatus =
  "created" | "starting" | "running" | "paused" | "stopping" | "stopped" | "error";

export interface BotRecord {
  id: string;
  name: string;
  strategy: string;
  symbol: string;
  market: MarketKind;
  mode: RunMode;
  /**
   * The wallet whose SoDEX account this bot trades (lowercase). Unset: the server's
   * own account (SODEX_USER_ADDRESS), e.g. bots run from the terminal.
   */
  owner?: string | undefined;
  config: unknown;
  status: BotStatus;
  statusReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface BotEvent {
  time: number;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  data?: unknown;
}

/** One process run of a bot: from start (or resume) until it stops or disconnects. */
export interface SessionRecord {
  id: number;
  botId: string;
  startedAt: number;
  /** Unset while running, or when the process died without closing the session. */
  endedAt?: number | undefined;
  /** "stopped: <reason>", "disconnected", … */
  endReason?: string | undefined;
}

export type { MarketSymbol };
