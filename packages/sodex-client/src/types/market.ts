import type { OrderSideName } from "../enums.ts";
import type { DecimalString, Uint64 } from "./common.ts";

interface SymbolFilters {
  id: number;
  name: string;
  displayName: string;
  quoteCoinID: number;
  quoteCoin?: string;
  quoteCoinPrecision?: number;
  pricePrecision: number;
  tickSize: DecimalString;
  minPrice: DecimalString;
  maxPrice: DecimalString;
  quantityPrecision: number;
  stepSize: DecimalString;
  minQuantity: DecimalString;
  maxQuantity: DecimalString;
  marketMinQuantity: DecimalString;
  marketMaxQuantity: DecimalString;
  minNotional: DecimalString;
  maxNotional: DecimalString;
  /** Limit buy price must be <= markPrice * (1 + buyLimitUpRatio). */
  buyLimitUpRatio: DecimalString;
  /** Limit sell price must be >= markPrice * (1 - sellLimitDownRatio). */
  sellLimitDownRatio: DecimalString;
  marketDeviationRatio: DecimalString;
  makerFee?: DecimalString;
  takerFee?: DecimalString;
  status?: "TRADING" | "HALT" | string;
}

export interface SpotSymbol extends SymbolFilters {
  baseCoinID: number;
  baseCoin?: string;
  baseCoinPrecision?: number;
}

export interface MarginTier {
  maxNotionalValue: DecimalString;
  maintenanceMarginRate: DecimalString;
  maxLeverage: number;
  maintenanceDeduction: DecimalString;
}

export interface PerpsSymbol extends SymbolFilters {
  baseCoin: string;
  openInterestCap?: DecimalString;
  openInterestCapUSD?: DecimalString;
  maxLeverage: number;
  initLeverage: number;
  marginTiers: MarginTier[];
  fundingInterval?: number;
  interestRate?: DecimalString;
  maxFundingRate?: DecimalString;
  minFundingRate?: DecimalString;
}

export type MarketSymbol = SpotSymbol | PerpsSymbol;

export interface Coin {
  id: number;
  name: string;
  precision: number;
  marginRatio?: DecimalString;
  price?: DecimalString;
}

export interface Ticker {
  symbol: string;
  lastPx: DecimalString;
  lastSz?: DecimalString;
  openPx: DecimalString;
  highPx: DecimalString;
  lowPx: DecimalString;
  vwap?: DecimalString;
  change?: DecimalString;
  changePct?: number;
  volume: DecimalString;
  quoteVolume: DecimalString;
  bidPx: DecimalString;
  bidSz: DecimalString;
  askPx: DecimalString;
  askSz: DecimalString;
  openTime: number;
  closeTime: number;
  /** Perps only. */
  fundingRate?: DecimalString;
  nextFundingTime?: number;
  indexPrice?: DecimalString;
  markPrice?: DecimalString;
  openInterest?: DecimalString;
}

export interface MarkPrice {
  symbol: string;
  markPrice: DecimalString;
  indexPrice: DecimalString;
  fundingRate: DecimalString;
  nextFundingTime: number;
  openInterest: DecimalString;
}

export interface BookTicker {
  symbol: string;
  bidPx: DecimalString;
  bidSz: DecimalString;
  askPx: DecimalString;
  askSz: DecimalString;
}

export interface OrderBook {
  blockTime: number;
  blockHeight: Uint64;
  updateID: Uint64;
  bids: [DecimalString, DecimalString][];
  asks: [DecimalString, DecimalString][];
}

/** Note: kline decimals are not always canonical (e.g. "77358.000000000000000000"). */
export interface Kline {
  t: number;
  o: DecimalString;
  h: DecimalString;
  l: DecimalString;
  c: DecimalString;
  v: DecimalString;
  q: DecimalString;
  n?: number;
}

export type PerpsKlineInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w" | "1M";
export type SpotKlineInterval = PerpsKlineInterval | "3m" | "2h" | "6h" | "8h" | "12h" | "3d";

export interface MarketTrade {
  t: Uint64;
  T: number;
  s: string;
  p: DecimalString;
  q: DecimalString;
  S: OrderSideName;
  bi?: Uint64;
  si?: Uint64;
}

export interface KlineQuery {
  startTime?: number;
  endTime?: number;
  /** Default 500, max 1000. */
  limit?: number;
}
