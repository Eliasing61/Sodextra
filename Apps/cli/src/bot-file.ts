import { readFileSync } from "node:fs";

import {
  parseRiskSettings,
  type BotRiskSettings,
  type MarketKind,
  type Strategy,
} from "@sodextra/engine-core";
import { getStrategy } from "@sodextra/strategies";

/**
 * A bot config file, e.g. bots/probe-btc.json:
 *   {
 *     "name": "probe-btc", "strategy": "probe", "market": "perps", "symbol": "BTC-USD",
 *     "risk": { "maxNotional": 50, "maxLoss": 5 },
 *     ...strategy settings
 *   }
 * Everything besides the reserved fields below is handed to the strategy.
 */
export interface BotFile {
  path: string;
  name: string;
  strategyName: string;
  /** The wallet whose account this bot trades (bots started from the website); unset = .env's. */
  owner?: `0x${string}` | undefined;
  market: MarketKind;
  symbol: string;
  strategy: Strategy<unknown, unknown>;
  config: unknown;
  /** The user's limits for this bot, enforced by the engine for every strategy. */
  risk: BotRiskSettings;
  /** Paper-trading starting balances. */
  paper: { quoteBalance: string; baseBalance: string };
  raw: Record<string, unknown>;
}

const RESERVED = new Set(["name", "strategy", "market", "symbol", "risk", "paper", "owner"]);

export function loadBotFile(path: string): BotFile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Could not read bot file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const name = String(raw.name ?? "");
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    throw new Error(`${path}: "name" must be 1–40 lowercase letters, digits, - or _`);
  }
  const market = raw.market ?? "perps";
  if (market !== "perps" && market !== "spot")
    throw new Error(`${path}: "market" must be "perps" or "spot"`);
  if (typeof raw.symbol !== "string" || raw.symbol === "")
    throw new Error(`${path}: "symbol" is required, e.g. "BTC-USD"`);
  if (typeof raw.strategy !== "string") throw new Error(`${path}: "strategy" is required`);
  if (raw.owner !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(String(raw.owner))) {
    throw new Error(`${path}: "owner" must be a wallet address`);
  }
  const owner =
    raw.owner === undefined ? undefined : (String(raw.owner).toLowerCase() as `0x${string}`);

  const strategy = getStrategy(raw.strategy);
  const settings = Object.fromEntries(Object.entries(raw).filter(([key]) => !RESERVED.has(key)));
  const paperRaw = (raw.paper ?? {}) as Record<string, unknown>;
  let risk: BotRiskSettings;
  try {
    risk = parseRiskSettings(raw.risk);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return {
    path,
    name,
    strategyName: raw.strategy,
    owner,
    market,
    symbol: raw.symbol,
    strategy,
    config: strategy.parseConfig(settings),
    risk,
    paper: {
      quoteBalance: String(paperRaw.quoteBalance ?? "1000"),
      baseBalance: String(paperRaw.baseBalance ?? "0"),
    },
    raw,
  };
}
