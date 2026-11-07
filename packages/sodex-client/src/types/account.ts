import type {
  MarginModeName,
  OrderSideName,
  OrderStatusName,
  OrderTypeName,
  PositionSideName,
  StopTypeName,
  TimeInForceName,
  TriggerTypeName,
} from "../enums.ts";
import type { Address, DecimalString, Uint64 } from "./common.ts";

export interface Subaccount {
  id: Uint64;
  evmAddress: Address;
}

export interface UserSubaccounts {
  userID: Uint64;
  primaryAccountID: Uint64;
  subaccounts: Subaccount[];
}

export interface ApiKeyInfo {
  name: string;
  type: string;
  publicKey: string;
  /** Milliseconds; 0 means no expiry. */
  expiresAt: number;
  /** A set bit DISABLES the permission (see APIKeyPermission). */
  permissions?: number;
}

export interface AccountApiKeys {
  spot: ApiKeyInfo[];
  perps: ApiKeyInfo[];
}

/** Address-based action budget (1 action per 1 USDC traded + initial buffer). */
export interface UserRateLimit {
  userID: Uint64;
  cumulativeTxNum: Uint64;
  cumulativeCancelNum: Uint64;
  cumulativeVolume: DecimalString;
  transactionQuota: number;
  transactionQuotaUsed: Uint64;
  transactionQuotaRemaining: number;
  transactionQuotaOverridden: boolean;
  cancelQuota: number;
  cancelQuotaUsed: Uint64;
  cancelQuotaRemaining: number;
}

export interface OrderBuilder {
  builderID: Uint64;
  feeRate: number;
}

export interface SpotBalance {
  id: number;
  coin: string;
  /** Includes locked funds. */
  total: DecimalString;
  locked: DecimalString;
}

export interface SpotBalances {
  blockTime: number;
  blockHeight: Uint64;
  balances: SpotBalance[];
}

export interface PerpsBalance {
  id: number;
  coin: string;
  /** Wallet balance. */
  total: DecimalString;
  collateral: DecimalString;
  marginRatio: DecimalString;
  price?: DecimalString;
}

export interface PerpsBalances {
  blockTime: number;
  blockHeight: Uint64;
  balances: PerpsBalance[];
}

export interface SpotOrder {
  orderID: Uint64;
  clOrdID?: string;
  symbol: string;
  side: OrderSideName;
  type: OrderTypeName;
  timeInForce?: TimeInForceName;
  price?: DecimalString;
  origQty?: DecimalString;
  funds?: DecimalString;
  executedQty: DecimalString;
  executedValue: DecimalString;
  marginFrozen: DecimalString;
  builder?: OrderBuilder;
  status: OrderStatusName;
  createdAt?: number;
  updatedAt?: number;
}

export interface PerpsOrder extends SpotOrder {
  positionSide: PositionSideName;
  reduceOnly: boolean;
  stopPrice?: DecimalString;
  stopType?: StopTypeName;
  triggerType?: TriggerTypeName;
  positionID?: Uint64;
  primaryOrderID?: Uint64;
  attachedOrderIDs?: Uint64[];
}

export interface OpenOrders<T> {
  blockTime: number;
  blockHeight: Uint64;
  orders: T[];
}

export interface Position {
  id: Uint64;
  symbol: string;
  marginMode: MarginModeName;
  positionSide: PositionSideName;
  /** Positive = long, negative = short, zero = closed. */
  size: DecimalString;
  initialMargin: DecimalString;
  avgEntryPrice: DecimalString;
  cumOpenCost: DecimalString;
  cumTradingFee: DecimalString;
  cumFundingFee: DecimalString;
  cumClosedSize: DecimalString;
  avgClosePrice: DecimalString;
  maxSize: DecimalString;
  realizedPnL: DecimalString;
  leverage: number;
  active: boolean;
  isTakenOver: boolean;
  takeOverPrice: DecimalString;
  createdAt: number;
  updatedAt: number;
}

export interface OpenPositions {
  blockTime: number;
  blockHeight: Uint64;
  positions: Position[];
}

export interface UserTrade {
  symbol: string;
  tradeID: Uint64;
  orderID: Uint64;
  clOrdID: string;
  side: OrderSideName;
  price: DecimalString;
  quantity: DecimalString;
  /** Total fee, already includes builderFee. */
  fee?: DecimalString;
  builderFee?: DecimalString;
  feeCoin?: string;
  isMaker?: boolean;
  time: number;
}

export interface PerpsFunding {
  symbol: string;
  positionID: Uint64;
  positionSide: PositionSideName;
  /** Negative = received. */
  fundingFee: DecimalString;
  feeCoin: string;
  timestamp: number;
}

export interface FeeRate {
  makerFeeRate: DecimalString;
  takerFeeRate: DecimalString;
  feeTier: number;
  stakingTier: number;
  makerRebateTier: number;
}

/** Compact "frontend state" shape returned by /accounts/{addr}/state (also the accountState WS channel). */
export interface PerpsBalanceDetailed {
  i: number;
  a: string;
  wb: DecimalString;
  co: DecimalString;
  mr: DecimalString;
  px: DecimalString;
  iw: DecimalString | null;
  /** Available wallet balance for margin. */
  aw: DecimalString;
  /** Available for transfer/withdrawal. */
  at: DecimalString;
  wm: DecimalString;
  am: DecimalString;
}

export interface PerpsStatePosition {
  i: Uint64;
  s: string;
  m: MarginModeName;
  ps: PositionSideName;
  sz: DecimalString;
  iw: DecimalString | null;
  ep: DecimalString;
  co: DecimalString;
  cf: DecimalString;
  cc: DecimalString;
  cp: DecimalString;
  ms: DecimalString;
  cr: DecimalString;
  ur: DecimalString;
  l: number;
  /** Liquidation price. */
  lp: DecimalString;
}

export interface PerpsSymbolConfig {
  s: string;
  l: number;
  m: MarginModeName;
}

export interface PerpsState {
  user: Address;
  /** Account ID — use this as `accountID` in signed requests. */
  aid: Uint64;
  uid: Uint64;
  av: DecimalString;
  am: DecimalString;
  ami: DecimalString;
  amw: DecimalString;
  im: DecimalString;
  cm: DecimalString;
  oim: DecimalString;
  ocm: DecimalString;
  B: PerpsBalanceDetailed[];
  /** Latest 100 open orders (compact WS order shape). */
  O: unknown[];
  P: PerpsStatePosition[];
  TO: unknown[];
  DO: unknown[];
  S: PerpsSymbolConfig[];
}

export interface SpotState {
  user: Address;
  aid: Uint64;
  uid: Uint64;
  B: { i: number; a: string; t: DecimalString; l: DecimalString }[];
  O: unknown[];
  TO: unknown[];
  DO: unknown[];
}
