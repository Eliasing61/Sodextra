/**
 * What the dashboard API sends to the web app. Standalone (no imports) so the web
 * app can import these types directly. Numbers are plain JS numbers: fine for
 * display; the engine keeps exact decimals.
 */

export type BotStatus =
  "created" | "starting" | "running" | "paused" | "stopping" | "stopped" | "error";

export interface BotListItem {
  id: string;
  name: string;
  strategy: string;
  symbol: string;
  market: "spot" | "perps";
  mode: "paper" | "live" | "backtest";
  status: BotStatus;
  statusReason?: string | undefined;
  /** A process is running this bot right now. */
  online: boolean;
  updatedAt: number;
  volume: number;
  volumeToday: number;
  pnl: number | null;
  /** USDC per $1M of volume; null without volume. */
  costPerMillion: number | null;
  /** Signed base size. */
  position: number;
  /**
   * The current (or last) run only: a bot started again under the same name keeps its
   * history, so the totals above mix runs. Null for Funding Carry.
   */
  run: PeriodStats | null;
  /** Today (UTC) only, the same way. Null for Funding Carry. */
  today: PeriodStats | null;
  /** The bot's latest line of activity (what it just did), for the dashboard row. */
  lastEvent?: EventView | undefined;
  /**
   * Taken off the dashboard's list by its owner (a stopped bot): its runs and trades stay in
   * History and the totals; starting it again (or a bot of the same name) brings it back.
   */
  hidden?: boolean;
}

/** One run of a bot (start/resume until stop or disconnect), with what it traded. */
export interface SessionView {
  id: number;
  botId: string;
  botName: string;
  strategy: string;
  symbol: string;
  mode: "paper" | "live" | "backtest";
  startedAt: number;
  /** Null while running. */
  endedAt: number | null;
  running: boolean;
  /** "stopped: …", "disconnected", or "process ended" when it died without closing. */
  endReason: string | null;
  volume: number;
  fills: number;
  makerShare: number | null;
  fees: number;
  /** Realised PnL of this session's fills, after fees. */
  realisedNet: number;
  /** Realised cost in bp of volume (fees + realised PnL); null without fills. */
  costBps: number | null;
}

/** One bar of the volume chart. */
export interface Bar {
  /** Start of the bar (ms). */
  at: number;
  volume: number;
  fills: number;
  /** Realised cost of the bar's fills in bp of volume (fees + realised PnL); null without fills. */
  costBps: number | null;
}

export interface FillView {
  id: string;
  at: number;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  maker: boolean;
}

export interface EventView {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface OrderView {
  key: string;
  side: "BUY" | "SELL";
  /**
   * A stop order (e.g. a Grid bot's stop-loss) has no limit price: show stopPrice. Always
   * sent by the API; optional so hand-made views (the demo bot) still fit.
   */
  kind?: "limit" | "stop" | "market";
  price: number | null;
  stopPrice?: number | null;
  quantity: number | null;
  status: string;
  postOnly: boolean;
}

/** What a bot traded over one stretch of time. */
export interface PeriodStats {
  /** Start of the period (ms). */
  since: number;
  volume: number;
  fills: number;
  fees: number;
  makerShare: number | null;
  /** Realised PnL of the period's fills after fees, plus the open position's PnL now. */
  pnl: number;
  /** USDC per $1M of volume (positive = cost); null without volume. */
  costPerMillion: number | null;
}

/** Every live Sodextra bot of one type, added up (all users; no one's bots are named). */
export interface BotTypeStats {
  bots: number;
  runs: number;
  /** USDC traded. */
  volume: number;
  /** Net result in USDC (fees, trading and funding). */
  pnl: number;
  /** Net result per volume (bp); positive = profit. Null without volume. */
  bps: number | null;
}

/** A Funding Carry bot: where its hedge is, what it earned, and what it sees. */
export interface CarryView {
  phase: "idle" | "building" | "holding" | "unwinding";
  /** Perp market held (or being built / unwound). */
  market: string | null;
  coin: string | null;
  /** Next market (a move in progress). */
  next: string | null;
  reason: string | null;
  size: number;
  leverage: number;
  /** Signed perp position and coins held on spot, with their USDC value. */
  perp: { symbol: string; position: number; usd: number } | null;
  spot: { symbol: string; position: number; usd: number } | null;
  /** USDC the legs differ by. */
  imbalanceUsd: number;
  /** Funding on the held market: now and smoothed (bp per hour). */
  fundingNowBpH: number | null;
  fundingAvgBpH: number | null;
  /** Next funding payment (top of the hour). */
  nextFundingAt: number;
  fundingReceived: number;
  fundingByMarket: Record<string, number>;
  /** Both legs' PnL (fees included) without funding, and fees paid. */
  legsPnl: number;
  fees: number;
  /** % the perp price can rise before liquidation, when known. */
  liqDistancePct: number | null;
  /** Best markets right now (smoothed funding first). */
  ranked: {
    market: string;
    coin: string;
    emaBpH: number;
    fundingBpH: number;
    gapBps: number;
    eligible: boolean;
    why: string[];
  }[];
  scannedAt: number | null;
  moves: { at: number; from: string | null; to: string | null; reason: string }[];
}

/** Which stretch of a bot's history the profit chart shows ("run": since it last started). */
export type ProfitPeriod = "run" | "day" | "week" | "all";

/** A bot's profit over time (GET /bots/:id/profit?period=…), oldest first. */
export interface ProfitView {
  period: ProfitPeriod;
  /** Where the chart's time axis starts (ms). */
  from: number;
  /** Totals at each time: over the bot's life for "all", made since `from` otherwise (USDC). */
  points: { at: number; pnl: number; gridProfit: number; roundTrips: number }[];
}

/** A Grid bot: its price lines, which of them hold an order, and what the grid made. */
export interface GridView {
  /** waiting: for data or the trigger price; opening: building the starting position; running; done. */
  phase: "waiting" | "opening" | "running" | "done";
  /** Price lines, lowest first; empty until the grid is laid out. */
  lines: number[];
  /** Side each line should hold, by index into lines (null = empty). */
  slots: ("BUY" | "SELL" | null)[];
  /** Base size of each line's order; null until laid out. */
  quantity: number | null;
  roundTrips: number;
  /** Gross profit of completed round trips, before fees (USDC). */
  gridProfit: number;
  /** The price is outside the range (running). */
  outOfRange: "below" | "above" | null;
  /** Not laid out yet because the price is outside the range. */
  waitingForRange: boolean;
  /** The starting position being built (opening phase), or null. */
  start: { side: "BUY" | "SELL"; quantity: number; filled: number } | null;
}

export interface BotView {
  id: string;
  name: string;
  strategy: string;
  symbol: string;
  market: "spot" | "perps";
  mode: "paper" | "live" | "backtest";
  status: BotStatus;
  statusReason?: string | undefined;
  online: boolean;
  startedAt: number;
  /** Server time when this view was built. */
  asOf: number;
  /** Funding Carry bots only. */
  carry?: CarryView;
  /** Grid bots only. */
  grid?: GridView;
  /** Strategy settings the dashboard knows how to show (maker and Grid bot fields). */
  config: {
    orderSize?: number;
    levels?: number;
    maxInventory?: number;
    maxActionsPerDollar?: number;
    leverage?: number;
    /** Stop once a run has traded this much (USDC). */
    volumeTarget?: number;
    /** Grid bots: "neutral" | "long" | "short" | "spot". */
    type?: string;
    lower?: number;
    upper?: number;
    grids?: number;
    /** Grid bots: "arithmetic" | "geometric". */
    spacing?: string;
    /** Grid bots: USDC margin (perps) or capital (spot). */
    investment?: number;
    /** Grid bots: live orders per side around the price. */
    window?: number;
    stopLossLow?: number;
    stopLossHigh?: number;
    /** Taker Volume: follows Binance's lead. */
    smartTiming?: boolean;
  };
  /** Taker Volume with smart timing: following Binance's lead right now (not on the timer). */
  followingBinance?: boolean;
  risk: {
    maxNotional?: number;
    maxLoss?: number;
    maxOpenOrders?: number;
    maxLeverage?: number;
  } | null;
  metrics: {
    volumeToday: number;
    volume14d: number;
    volumeTotal: number;
    /** 0…1, or null before the first fill. */
    makerShare: number | null;
    fees: number;
    realised: number;
    unrealised: number;
    pnl: number;
    /** USDC of net cost per $1M of volume (positive = cost); null without volume. */
    costPerMillion: number | null;
    actions: number;
    actionsPerDollar: number | null;
    /** Address actions left on SoDEX (live bots only). */
    actionBudget: number | null;
    fills24h: number;
    fillsTotal: number;
    /** Signed base size. */
    position: number;
    positionUsd: number;
    avgEntry: number;
    mark: number | null;
  };
  /** The same figures for the current session, today (UTC), the last 7 days and all time. */
  periods: { session: PeriodStats; today: PeriodStats; week: PeriodStats; all: PeriodStats };
  /** Runs of this bot, newest first (for marking them on the chart). endedAt null = running now. */
  sessions: { startedAt: number; endedAt: number | null }[];
  orders: OrderView[];
  bars: Bar[];
  /** Bar width in ms (5 min, 30 min or 1 h, depending on how long the bot has traded). */
  barMs: number;
  fills: FillView[];
  events: EventView[];
  /** Strategy status lines (e.g. pacing, inventory). */
  notes: string[];
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface StartResult extends CommandResult {
  botId?: string | undefined;
  /** The tail of the bot's log when it failed to start. */
  log?: string | undefined;
  /** Refused for Sodextra's fee approval (tenths of a bp): the website shows its notice. */
  approval?: { fee: number; approvedFee: number } | undefined;
}

/** Owner-only overview of the server: health, capacity, and who is running what. */
export interface AdminView {
  asOf: number;
  server: {
    uptimeSec: number;
    /** 1, 5 and 15-minute load averages (0 on Windows). */
    load: number[];
    cpus: number;
    memTotal: number;
    /** Memory still available to programs (Linux MemAvailable), bytes. */
    memAvailable: number;
    /** Disk holding the data directory, bytes; null if it couldn't be read. */
    diskTotal: number | null;
    diskFree: number | null;
    apiRss: number;
    apiUptimeSec: number;
  };
  capacity: {
    /** People and connections on each of the server's addresses (empty: just the default one). */
    addresses: { address: string; users: number; connections: number }[];
    /** SoDEX connections the running bots hold (a Funding Carry bot holds two). */
    slotsUsed: number;
    maxSlots: number;
    maxPerUser: number;
    /** Bots each wallet but the owner's may run during early access. */
    maxPerGuest: number;
    usersRunning: number;
    /** SoDEX's limit of unique users per IP. */
    maxUsers: number;
    /** Early-access run spots for people other than the owner. */
    spots: { total: number; left: number };
  };
  running: AdminBot[];
  users: AdminUser[];
  access: {
    /** "anyone", or how many wallets may sign in. */
    signIn: "anyone" | number;
  };
}

export interface AdminBot {
  id: string;
  name: string;
  account: string;
  strategy: string;
  symbol: string;
  status: BotStatus;
  statusReason?: string | undefined;
  volume: number;
  volumeToday: number;
  pnl: number | null;
  /** The current run's figures (the admin table's "This session"); null for Funding Carry. */
  run: PeriodStats | null;
  /** Today's (UTC); null for Funding Carry. */
  today: PeriodStats | null;
  updatedAt: number;
}

export interface AdminUser {
  account: string;
  bots: number;
  running: number;
  volume: number;
  volumeToday: number;
  /** Last update of any of its bots. */
  lastActive: number;
}
