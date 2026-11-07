import { runBacktest } from "@sodextra/engine-core";
import { SodexClient } from "@sodextra/sodex-client";

import { loadBotFile } from "../bot-file.ts";
import { env } from "../env.ts";
import { loadCandles } from "../market.ts";
import { c, fmt, signed, time } from "../print.ts";
import { checkBot, printValidation } from "./validate.ts";

export async function backtestCommand(path: string, days: number): Promise<number> {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error("--days must be a whole number from 1 to 90");
  const file = loadBotFile(path);
  if (file.strategy.candleBacktest === false) {
    console.log(
      `The ${file.strategyName} strategy can't be judged on 1-minute candles: quoting depends on queue position in the live order book. Use paper mode instead:\n  npm run bot -- paper ${path}`,
    );
    return 1;
  }
  const checked = await checkBot(file);
  printValidation(file, checked);
  if (!checked.result.ok) return 1;

  const client = new SodexClient({ network: env.network });
  process.stdout.write(`\nLoading ${days} day(s) of 1-minute candles…`);
  const candles = await loadCandles(client, file.market, file.symbol, days, (done, total) =>
    process.stdout.write(`\rLoading ${days} day(s) of 1-minute candles… ${done}/${total} pages`),
  );
  console.log(` ${candles.length} candles`);

  const started = Date.now();
  const r = await runBacktest({
    strategy: file.strategy,
    config: file.config,
    market: file.market,
    symbol: checked.market.symbol,
    candles,
    candleMs: 60_000,
    makerFee: checked.market.makerFee,
    takerFee: checked.market.takerFee,
    quoteBalance: file.paper.quoteBalance,
    baseBalance: file.paper.baseBalance,
    risk: file.risk,
  });

  console.log(
    `\n${c.bold("Backtest")} ${time(r.from)} → ${time(r.to)} (${r.candles} candles, ran in ${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  console.log(`  fills          ${r.fills}  (volume ${fmt(r.volume, 2)} USDC)`);
  console.log(`  realised PnL   ${signed(r.realizedPnl)}`);
  console.log(
    `  unrealised PnL ${signed(r.unrealizedPnl)}  (position ${r.finalPosition} at ${r.finalPrice})`,
  );
  console.log(`  fees           ${fmt(r.fees)}`);
  console.log(`  total PnL      ${signed(r.totalPnl)}`);
  console.log(`  max drawdown   ${fmt(r.maxDrawdown)}`);
  console.log(`  ended          ${r.status}${r.statusReason ? ` (${r.statusReason})` : ""}`);
  for (const line of file.strategy.describe?.(file.config, r.strategyState) ?? []) {
    console.log(`  ${line}`);
  }
  for (const e of r.events.slice(0, 10)) console.log(c.dim(`  ${e.level}: ${e.message}`));
  console.log(
    c.dim(
      "  Simulation: fills need price to trade through the order; no slippage or funding modelled.",
    ),
  );
  return 0;
}
