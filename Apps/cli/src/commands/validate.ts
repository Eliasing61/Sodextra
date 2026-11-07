import { SodexClient, toDecimal } from "@sodextra/sodex-client";
import { describeRisk, type ValidationResult } from "@sodextra/engine-core";

import { loadBotFile, type BotFile } from "../bot-file.ts";
import { accountOf, builderFor, env, useAccountOf } from "../env.ts";
import { loadMarket, type MarketInfo } from "../market.ts";
import { c } from "../print.ts";

/** The builder fee this bot's live orders pay, as a fraction ("0.00001" = 0.1 bp). */
export function builderFeeOf(file: BotFile): string {
  const b = builderFor(accountOf(file));
  return b ? String(b.fee / 100_000) : "0";
}

/**
 * `resuming`: the bot was running (a restart or a disconnect), so its own position and orders
 * already use the account's balance: don't check it against what's left.
 */
export async function checkBot(
  file: BotFile,
  mode: "paper" | "live" | "check" = "check",
  { resuming = false }: { resuming?: boolean } = {},
): Promise<{ result: ValidationResult; market: MarketInfo }> {
  const client = new SodexClient({ network: env.network });
  const market = await loadMarket(client, file.market, file.symbol);
  const availableQuote =
    mode === "paper"
      ? file.paper.quoteBalance
      : resuming
        ? undefined
        : await availableBalance(client, file);
  const result = file.strategy.validate(file.config, {
    availableQuote,
    symbol: market.symbol,
    market: file.market,
    markPrice: market.markPrice,
    makerFee: market.makerFee,
    takerFee: market.takerFee,
    builderFee: mode === "paper" ? "0" : builderFeeOf(file),
    risk: file.risk,
  });
  return { result, market };
}

/** USDC this account can put into the bot, when .env has an address. (Paper runs use their paper balance.) */
async function availableBalance(client: SodexClient, file: BotFile): Promise<string | undefined> {
  if (!env.userAddress) return undefined;
  try {
    if (file.market === "perps") {
      const state = await client.perps.state(env.userAddress);
      return state.am; // cross margin free to use, collateral coins included
    }
    const balances = await client.spot.balances(env.userAddress);
    const usdc = balances.balances.find((b) => b.coin === "vUSDC");
    return usdc ? toDecimal(usdc.total).minus(usdc.locked).toFixed() : "0";
  } catch {
    return undefined;
  }
}

export function printValidation(
  file: BotFile,
  { result, market }: Awaited<ReturnType<typeof checkBot>>,
): void {
  console.log(
    `${c.bold(file.name)}: ${file.strategyName} on ${file.symbol} (${file.market}), ${env.network}`,
  );
  console.log(
    c.dim(
      `  fees maker ${market.makerFee} / taker ${market.takerFee} (${market.feeSource}), builder fee ${builderFeeOf(file)}`,
    ),
  );
  console.log(`  risk limits: ${describeRisk(file.risk)}`);
  if (file.risk.maxNotional === undefined) {
    console.log(
      c.yellow('  ! no "risk.maxNotional" set: fine for paper/backtest, required for live'),
    );
  }
  for (const line of result.summary) console.log(`  ${line}`);
  for (const w of result.warnings) console.log(c.yellow(`  ! ${w}`));
  for (const e of result.errors) console.log(c.red(`  ✗ ${e}`));
  console.log(
    result.ok
      ? c.green("  ✓ config is valid")
      : c.red(`  ${result.errors.length} problem(s); fix the config before running`),
  );
}

export async function validateCommand(path: string): Promise<number> {
  const file = loadBotFile(path);
  useAccountOf(file);
  const checked = await checkBot(file);
  printValidation(file, checked);
  return checked.result.ok ? 0 : 1;
}
