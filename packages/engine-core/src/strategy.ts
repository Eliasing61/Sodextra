import type { BotRiskSettings } from "./risk.ts";
import type {
  BookTop,
  DesiredOrder,
  Fill,
  MarketEvent,
  MarketKind,
  MarketSymbol,
  RunMode,
  TrackedOrder,
} from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Human-readable lines for `validate` output (levels, sizes, fee check, ...). */
  summary: string[];
}

/** Market facts available when validating a config before anything is signed. */
export interface ValidationEnv {
  symbol: MarketSymbol;
  market: MarketKind;
  markPrice: string;
  /** Effective fee rates (decimal fractions, e.g. "0.00012"). */
  makerFee: string;
  takerFee: string;
  builderFee: string;
  /** Quote balance available for this bot (USDC), when known. */
  availableQuote?: string | undefined;
  /** The bot's own risk limits, so a strategy can reject configs that could never run within them. */
  risk: BotRiskSettings;
}

export interface StrategyContext<C> {
  readonly config: C;
  readonly symbol: MarketSymbol;
  readonly market: MarketKind;
  readonly mode: RunMode;
  now(): number;
  /** Latest mark price (perps) or mid price (spot); undefined until data arrives. */
  mark(): string | undefined;
  /** Best bid and ask, with the size resting at each when the feed sends it. */
  book(): BookTop | undefined;
  /** Perps: the latest index price (the outside exchanges' price the mark follows). */
  index?(): string | undefined;
  /** Net position the engine has tracked from this bot's own fills (signed). */
  position(): string;
  /** This bot's total PnL so far: realised + unrealised − fees (USDC). */
  totalPnl(): string;
  /** This bot's traded volume so far (USDC notional, all runs). */
  volume(): string;
  /** Volume of the current run only (since the bot was last started from stopped). */
  runVolume(): string;
  /** Address actions this bot has used so far (orders placed, cancelled or replaced). */
  actions(): number;
  /**
   * Open orders on this market that aren't this bot's (another bot's, or placed by hand),
   * as of the last account check (every reconcile). A taker must not trade against them.
   */
  otherOrders?(): number;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  /** Ask the engine to stop the bot after this cycle. */
  requestStop(reason: string, options: { closePosition: boolean }): void;
}

/**
 * A strategy is pure decision logic. It never talks to the exchange: it keeps
 * its own JSON-serialisable state and, each cycle, returns the orders it wants
 * resting on the book. The engine handles placing, cancelling, retries,
 * recovery and risk checks.
 */
export interface Strategy<C = unknown, S = unknown> {
  readonly name: string;
  /** 2–4 lowercase letters used in clOrdIDs, e.g. "g" → sxg-... */
  readonly idPrefix: string;
  /**
   * Quoting strategies (market making) must not leave orders behind: the engine
   * arms the exchange dead-man switch while running and cancels their orders on
   * Ctrl+C. Resting strategies (grid) leave orders on the book by design.
   */
  readonly quoting?: boolean;
  /** False when candle backtests can't judge this strategy (e.g. quoting needs a queue model). */
  readonly candleBacktest?: boolean;
  /** Parse and check a raw config; throw on structural errors. */
  parseConfig(raw: unknown): C;
  validate(config: C, env: ValidationEnv): ValidationResult;
  initialState(ctx: StrategyContext<C>): S;
  /**
   * The Binance futures symbol whose prices this config wants as "ref" market events (e.g.
   * "BTCUSDT"), or undefined for none. The runner opens that feed next to SoDEX's.
   */
  reference?(config: C, symbol: MarketSymbol): string | undefined;
  /** Optional one-off setup before the first order (e.g. leverage). */
  setup?(ctx: StrategyContext<C>): { leverage?: number; marginMode?: "ISOLATED" | "CROSS" };
  onMarket?(ctx: StrategyContext<C>, state: S, event: MarketEvent): void;
  onFill?(ctx: StrategyContext<C>, state: S, fill: Fill, order: TrackedOrder): void;
  /** An order closed without filling completely (cancelled, rejected, expired). */
  onOrderClosed?(ctx: StrategyContext<C>, state: S, order: TrackedOrder): void;
  desired(ctx: StrategyContext<C>, state: S): DesiredOrder[];
  /** Strategy-specific status lines (round trips, grid profit, ...) for status and backtest output. */
  describe?(config: C, state: S): string[];
  /** Numbers to keep with each minute's PnL sample, for the dashboard's charts (e.g. grid profit). */
  sample?(state: S): Record<string, number>;
}
