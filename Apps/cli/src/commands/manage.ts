import {
  BotEngine,
  LiveExchange,
  PaperExchange,
  SqliteStore,
  type BotRecord,
  type ExchangeAdapter,
  type SimState,
} from "@sodextra/engine-core";
import {
  OrderSide,
  OrderType,
  roundQuantity,
  SodexClient,
  TimeInForce,
  toDecimal,
} from "@sodextra/sodex-client";
import { getStrategy } from "@sodextra/strategies";

import { loadBotFile } from "../bot-file.ts";
import { DB_PATH, env, requireSigner, requireUser, useAccountOf } from "../env.ts";
import { lockHolder } from "../lock.ts";
import { loadMarket } from "../market.ts";
import { c, describeBot, logEvent, time } from "../print.ts";
import { resolveAccountId } from "./run.ts";

export async function listCommand(): Promise<number> {
  const store = new SqliteStore(DB_PATH);
  const bots = store.listBots();
  if (bots.length === 0)
    console.log("No bots yet. Start one with: npm run bot -- paper bots/<file>.json");
  for (const bot of bots) for (const line of describeBot(store, bot)) console.log(line);
  store.close();
  return 0;
}

export async function statusCommand(path: string | undefined): Promise<number> {
  const store = new SqliteStore(DB_PATH);
  try {
    const bots = path ? matchingBots(store, loadBotFile(path).name) : store.listBots();
    if (bots.length === 0) {
      console.log("No matching bots in .sodextra/sodextra.db.");
      return 1;
    }
    const client = new SodexClient({ network: env.network });
    for (const bot of bots) {
      let mark: string | undefined;
      try {
        mark = (await loadMarket(client, bot.market, bot.symbol)).markPrice;
      } catch {
        mark = undefined;
      }
      const holder = lockHolder(bot.id);
      for (const line of describeBot(store, bot, mark)) console.log(line);
      console.log(
        c.dim(holder ? `  running in process ${holder}` : "  not running in any process"),
      );
      for (const e of store.recentEvents(bot.id, 8).reverse()) {
        console.log(c.dim(`  ${time(e.time)} ${e.level.padEnd(5)} ${e.message}`));
      }
      console.log();
    }
    return 0;
  } finally {
    store.close();
  }
}

function matchingBots(store: SqliteStore, name: string): BotRecord[] {
  return store.listBots().filter((b) => b.name === name);
}

/** Cancel the bot's orders (and optionally close its position), then mark it stopped. */
export async function stopCommand(
  path: string,
  options: { close: boolean; paper: boolean },
): Promise<number> {
  const file = loadBotFile(path);
  useAccountOf(file);
  const mode = options.paper ? "paper" : "live";
  const store = new SqliteStore(DB_PATH);
  try {
    const bot = store.findBot(file.name, mode, file.owner);
    if (!bot) {
      console.log(`No ${mode} bot named "${file.name}".`);
      return 1;
    }
    const holder = lockHolder(bot.id);
    if (holder !== undefined) {
      throw new Error(
        `The bot is running in process ${holder}. Press Ctrl+C there first, then run stop.`,
      );
    }

    // Funding Carry: stop each leg it has opened (the parent has no market of its own).
    if (bot.strategy === "carry") {
      const record = store.getKV<{ legs: Record<string, { perpBot: string; spotBot: string }> }>(
        bot.id,
        "carry",
      );
      const leg = getStrategy("carry-leg");
      for (const ids of Object.values(record?.legs ?? {})) {
        for (const id of [ids.perpBot, ids.spotBot]) {
          const child = store.getBot(id);
          if (!child || child.status === "stopped") continue;
          await stopOne(
            store,
            child,
            leg,
            leg.parseConfig(child.config),
            mode,
            options.close,
            file.paper,
          );
        }
      }
      store.setBotStatus(bot.id, "stopped", "stopped from the CLI", Date.now());
      console.log(`Stopped ${file.name}${options.close ? " and closed its legs" : ""}.`);
      return 0;
    }
    await stopOne(store, bot, file.strategy, file.config, mode, options.close, file.paper);
    return 0;
  } finally {
    store.close();
  }
}

/** Attach to one bot's orders on the exchange, stop it (closing its position if asked). */
async function stopOne(
  store: SqliteStore,
  bot: BotRecord,
  strategy: ReturnType<typeof getStrategy>,
  config: unknown,
  mode: "paper" | "live",
  close: boolean,
  paper: { quoteBalance: string; baseBalance: string },
): Promise<void> {
  {
    const publicClient = new SodexClient({ network: env.network });
    const market = await loadMarket(publicClient, bot.market, bot.symbol);
    let exchange: ExchangeAdapter;
    if (mode === "live") {
      const user = requireUser();
      const client = new SodexClient({ network: env.network, signer: requireSigner() });
      const accountID = await resolveAccountId(client, user);
      exchange = new LiveExchange({
        client,
        user,
        accountID,
        market: bot.market,
        symbol: market.symbol,
      });
    } else {
      exchange = new PaperExchange({
        network: env.network,
        market: bot.market,
        symbol: market.symbol,
        makerFee: market.makerFee,
        takerFee: market.takerFee,
        quoteBalance: paper.quoteBalance,
        baseBalance: paper.baseBalance,
        restore: store.getKV<SimState>(bot.id, "paper"),
        persist: (state) => store.setKV(bot.id, "paper", state),
      });
    }

    const engine = new BotEngine({
      bot,
      strategy,
      config,
      exchange,
      store,
      onEvent: logEvent,
    });
    await engine.attach();
    await engine.stop({ closePosition: close, reason: "stopped from the CLI" });
    if (close) {
      // Give the close order a moment, then pick up its fill.
      await new Promise((r) => setTimeout(r, 3_000));
      await engine.reconcile();
    }
    await engine.detach();
    for (const line of describeBot(store, store.getBot(bot.id)!, market.markPrice))
      console.log(line);
  }
}

/**
 * Emergency: cancel every Sodextra order (clOrdID starting "sx") on both engines,
 * and with --close, market-close perps positions on symbols of local live bots.
 */
export async function panicCommand(options: { close: boolean }): Promise<number> {
  const user = requireUser();
  const client = new SodexClient({ network: env.network, signer: requireSigner() });
  const accountID = await resolveAccountId(client, user);
  const store = new SqliteStore(DB_PATH);
  try {
    let cancelled = 0;
    const perpsOpen = (await client.perps.openOrders(user, { accountID })).orders.filter((o) =>
      o.clOrdID?.startsWith("sx"),
    );
    const perpsSymbols = new Map((await client.perps.symbols()).map((s) => [s.name, s.id]));
    for (let i = 0; i < perpsOpen.length; i += 20) {
      const batch = perpsOpen.slice(i, i + 20);
      await client.perps.cancelOrders({
        accountID,
        cancels: batch.map((o) => ({ symbolID: perpsSymbols.get(o.symbol)!, clOrdID: o.clOrdID! })),
      });
      cancelled += batch.length;
    }
    const spotOpen = (await client.spot.openOrders(user, { accountID })).orders.filter((o) =>
      o.clOrdID?.startsWith("sx"),
    );
    const spotSymbols = new Map((await client.spot.symbols()).map((s) => [s.name, s.id]));
    for (let i = 0; i < spotOpen.length; i += 20) {
      const batch = spotOpen.slice(i, i + 20);
      await client.spot.cancelOrders({
        accountID,
        cancels: batch.map((o) => ({
          symbolID: spotSymbols.get(o.symbol)!,
          clOrdID: `${o.clOrdID!.slice(0, 34)}-x`,
          origClOrdID: o.clOrdID!,
        })),
      });
      cancelled += batch.length;
    }
    console.log(`Cancelled ${cancelled} Sodextra order(s).`);

    const liveBots = store.listBots().filter((b) => b.mode === "live");
    if (options.close) {
      const botSymbols = new Set(liveBots.filter((b) => b.market === "perps").map((b) => b.symbol));
      const positions = (await client.perps.positions(user, { accountID })).positions;
      for (const p of positions) {
        const size = toDecimal(p.size);
        if (size.isZero() || !botSymbols.has(p.symbol)) continue;
        const [r] = await client.perps.placeOrders({
          accountID,
          symbolID: perpsSymbols.get(p.symbol)!,
          orders: [
            {
              clOrdID: `sxx-panic-${Date.now().toString(36)}`,
              side: size.gt(0) ? OrderSide.SELL : OrderSide.BUY,
              type: OrderType.MARKET,
              timeInForce: TimeInForce.IOC,
              quantity: size.abs().toFixed(),
              reduceOnly: true,
            },
          ],
        });
        console.log(
          r?.code === 0
            ? `Closing ${p.symbol} ${p.size}`
            : c.red(`Could not close ${p.symbol}: ${r?.error}`),
        );
      }
    }
    if (options.close) {
      // Funding Carry spot legs hold coins: sell what they bought (spot has no positions to close).
      const spotList = await client.spot.symbols();
      const balances = (await client.spot.balances(user, { accountID })).balances;
      for (const bot of liveBots.filter((b) => b.strategy === "carry-leg" && b.market === "spot")) {
        const held = toDecimal(
          store.getKV<{ position: { size: string } }>(bot.id, "engine")?.position.size ?? "0",
        );
        const symbol = spotList.find((x) => x.name === bot.symbol);
        if (!symbol || !held.gt(0)) continue;
        const coin = balances.find((b) => b.coin === symbol.baseCoin);
        const free = coin ? toDecimal(coin.total).minus(coin.locked) : toDecimal(0);
        const quantity = roundQuantity(symbol, held.lt(free) ? held : free, "down");
        if (toDecimal(quantity).isZero()) continue;
        const [r] = await client.spot.placeOrders({
          accountID,
          orders: [
            {
              symbolID: symbol.id,
              clOrdID: `sxx-panic-${Date.now().toString(36)}`,
              side: OrderSide.SELL,
              type: OrderType.MARKET,
              timeInForce: TimeInForce.IOC,
              quantity,
            },
          ],
        });
        console.log(
          r?.code === 0
            ? `Selling ${quantity} on ${bot.symbol}`
            : c.red(`Could not sell ${bot.symbol}: ${r?.error}`),
        );
      }
    }
    for (const bot of liveBots) {
      if (bot.status !== "stopped") store.setBotStatus(bot.id, "stopped", "panic", Date.now());
    }
    if (liveBots.some((b) => lockHolder(b.id) !== undefined)) {
      console.log(
        c.yellow(
          "Some bots are still running in other terminals; press Ctrl+C there too, or they will place orders again.",
        ),
      );
    }
    return 0;
  } finally {
    store.close();
  }
}
