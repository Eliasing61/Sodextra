import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MarketKind } from "@sodextra/engine-core";
import type { Kline, MarketSymbol, SodexClient } from "@sodextra/sodex-client";

import { CACHE_DIR, env } from "./env.ts";

export interface MarketInfo {
  symbol: MarketSymbol;
  markPrice: string;
  makerFee: string;
  takerFee: string;
  /** Where the fee rates came from. */
  feeSource: "account" | "symbol default";
}

// Tier-0 defaults if the symbol doesn't carry fee rates.
const DEFAULT_FEES: Record<MarketKind, { maker: string; taker: string }> = {
  perps: { maker: "0.00012", taker: "0.0004" },
  spot: { maker: "0.00035", taker: "0.00065" },
};

export async function loadMarket(
  client: SodexClient,
  market: MarketKind,
  name: string,
): Promise<MarketInfo> {
  const api = market === "perps" ? client.perps : client.spot;
  const symbols: MarketSymbol[] = await api.symbols();
  const symbol = symbols.find((s) => s.name === name);
  if (!symbol) {
    const close = symbols
      .filter((s) => s.name.toLowerCase().includes(name.toLowerCase().split(/[-_]/)[0] ?? ""))
      .map((s) => s.name);
    throw new Error(
      `No ${market} market "${name}".${close.length ? ` Did you mean: ${close.slice(0, 5).join(", ")}?` : ""}`,
    );
  }

  let markPrice: string | undefined;
  if (market === "perps") {
    markPrice = (await client.perps.markPrices()).find((m) => m.symbol === name)?.markPrice;
  } else {
    const book = await client.spot.orderbook(name, 1);
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid && ask) markPrice = String((Number(bid) + Number(ask)) / 2);
  }
  if (!markPrice || Number(markPrice) <= 0) throw new Error(`No price available for ${name}`);

  let makerFee = symbol.makerFee ?? DEFAULT_FEES[market].maker;
  let takerFee = symbol.takerFee ?? DEFAULT_FEES[market].taker;
  let feeSource: MarketInfo["feeSource"] = "symbol default";
  if (env.userAddress) {
    try {
      const rate = await api.feeRate(env.userAddress);
      makerFee = rate.makerFeeRate;
      takerFee = rate.takerFeeRate;
      feeSource = "account";
    } catch {
      // Fall back to the symbol's default rates.
    }
  }
  return { symbol, markPrice, makerFee, takerFee, feeSource };
}

const MINUTE = 60_000;
const PAGE = 1000;

/**
 * 1-minute candles for the last `days`, ascending, cached under .sodextra/cache
 * so repeated backtests only download what's new.
 */
export async function loadCandles(
  client: SodexClient,
  market: MarketKind,
  symbol: string,
  days: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Kline[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${env.network}-${market}-${symbol}-1m.json`);
  const cache = new Map<number, Kline>();
  if (existsSync(file)) {
    for (const k of JSON.parse(readFileSync(file, "utf8")) as Kline[]) cache.set(k.t, k);
  }

  const end = Math.floor(Date.now() / MINUTE) * MINUTE - MINUTE; // last closed minute
  const start = end - days * 24 * 60 * MINUTE;
  const windows: [number, number][] = [];
  for (let from = start; from < end; from += PAGE * MINUTE) {
    const to = Math.min(from + PAGE * MINUTE - 1, end);
    let have = 0;
    for (let t = from; t <= to; t += MINUTE) if (cache.has(t)) have++;
    if (have < (to - from + 1) / MINUTE - 1) windows.push([from, to]);
  }

  const api = market === "perps" ? client.perps : client.spot;
  let done = 0;
  for (const [from, to] of windows) {
    const page = await api.klines(symbol, "1m", { startTime: from, endTime: to, limit: PAGE });
    for (const k of page) cache.set(k.t, k);
    onProgress?.(++done, windows.length);
  }

  const all = [...cache.values()].sort((a, b) => a.t - b.t);
  if (windows.length > 0)
    writeFileSync(file, JSON.stringify(all.filter((k) => k.t >= end - 90 * 24 * 60 * MINUTE)));
  return all.filter((k) => k.t >= start && k.t <= end);
}
