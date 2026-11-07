import { resolve } from "node:path";

import {
  BinanceFeed,
  botOrderPrefix,
  BotEngine,
  BotRunner,
  describeRisk,
  LiveExchange,
  newBotId,
  PaperExchange,
  SqliteStore,
  withReference,
  type BotRecord,
  type ExchangeAdapter,
  type RunMode,
  type SimState,
} from "@sodextra/engine-core";
import { SodexClient, toDecimal, type Uint64 } from "@sodextra/sodex-client";
import { STRATEGIES } from "@sodextra/strategies";

import { loadBotFile, type BotFile } from "../bot-file.ts";
import {
  accountOf,
  builderFor,
  DB_PATH,
  env,
  requireSigner,
  requireUser,
  signerSource,
  useAccountOf,
} from "../env.ts";
import { acquireLock, lockHolder } from "../lock.ts";
import { c, describeBot, logEvent } from "../print.ts";
import { checkBot, printValidation } from "./validate.ts";

/**
 * A bot paused this long stops (keeping any position), so it stops holding a place on the
 * server: a SoDEX connection and a person's spot. SODEXTRA_STOP_WHEN_PAUSED_MIN=0 turns it off.
 */
const STOP_WHEN_PAUSED_MS = Number(process.env.SODEXTRA_STOP_WHEN_PAUSED_MIN ?? 5) * 60_000;

/** Find this file's bot in the store, or create it. One bot per (name, mode). */
export function upsertBot(
  store: SqliteStore,
  file: BotFile,
  mode: RunMode,
  symbol: string,
): BotRecord {
  const existing = store.findBot(file.name, mode, file.owner);
  if (existing) {
    if (
      existing.strategy !== file.strategyName ||
      existing.symbol !== symbol ||
      existing.market !== file.market
    ) {
      throw new Error(
        `A ${mode} bot named "${file.name}" already exists for ${existing.strategy} on ${existing.symbol}. Use a different "name".`,
      );
    }
    if (JSON.stringify(existing.config) !== JSON.stringify(file.config)) {
      store.updateBotConfig(existing.id, file.config, Date.now());
      console.log(c.yellow("Config changed since last run; the new settings apply from now on."));
    }
    return { ...existing, config: file.config };
  }
  const now = Date.now();
  const bot: BotRecord = {
    id: newBotId(),
    name: file.name,
    strategy: file.strategyName,
    symbol,
    market: file.market,
    mode,
    ...(file.owner ? { owner: file.owner } : {}),
    config: file.config,
    status: "created",
    createdAt: now,
    updatedAt: now,
  };
  store.createBot(bot);
  return bot;
}

export async function resolveAccountId(client: SodexClient, user: `0x${string}`): Promise<Uint64> {
  if (env.accountId) return Number(env.accountId);
  return (await client.perps.state(user)).aid;
}

export async function runCommand(
  path: string,
  mode: "paper" | "live",
  confirmed: boolean,
): Promise<number> {
  const file = loadBotFile(path);
  useAccountOf(file);
  const store = new SqliteStore(DB_PATH);
  const prior = store.findBot(file.name, mode, file.owner);
  const resuming = prior !== undefined && prior.status !== "stopped" && prior.status !== "created";
  const checked = await checkBot(file, mode, { resuming });
  printValidation(file, checked);
  if (!checked.result.ok) {
    store.close();
    return 1;
  }

  let exchange: ExchangeAdapter;
  const bot = upsertBot(store, file, mode, checked.market.symbol.name);
  const release = acquireLock(bot.id);
  // Risk limits live in the bot file; keep a copy for status readers (the dashboard API).
  store.setKV(bot.id, "risk", file.risk);
  // So the dashboard can start this bot again from the same file.
  store.setKV(bot.id, "file", resolve(path));
  store.setKV(bot.id, "command", null);
  // The address its SoDEX traffic leaves from (the API counts people and connections per address).
  store.setKV(bot.id, "egress", process.env.SODEXTRA_EGRESS_IP ?? null);
  // The dashboard shows the bot online from the lock and its numbers from the latest run:
  // open the run now, not once connected, or the last run shows for the first seconds.
  // A start that fails before running leaves no run behind.
  const session = store.startSession(bot.id, Date.now());
  let started = false;

  try {
    if (mode === "live") {
      if (!file.risk.maxNotional) {
        throw new Error(
          `${path}: set "risk": { "maxNotional": ... } before running live (a hard cap on this bot's exposure in USDC).`,
        );
      }
      if (!confirmed) {
        console.log(
          c.yellow(
            `\nThis trades REAL money on SoDEX ${env.network} within this bot's limits (${describeRisk(file.risk)}). Re-run with --confirm.`,
          ),
        );
        return 0;
      }
      const user = requireUser();
      const client = new SodexClient({ network: env.network, signer: requireSigner() });
      console.log(
        c.dim(
          `Signing with API key "${client.signer!.apiKeyName}" from ${signerSource === "vault" ? "the encrypted key vault" : ".env"}`,
        ),
      );
      const accountID = await resolveAccountId(client, user);
      await guardLiveStart(client, user, accountID, file, bot, store);
      exchange = new LiveExchange({
        client,
        user,
        accountID,
        market: file.market,
        symbol: checked.market.symbol,
        builder: builderFor(accountOf(bot)),
      });
    } else {
      exchange = new PaperExchange({
        network: env.network,
        market: file.market,
        symbol: checked.market.symbol,
        makerFee: checked.market.makerFee,
        takerFee: checked.market.takerFee,
        quoteBalance: file.paper.quoteBalance,
        baseBalance: file.paper.baseBalance,
        restore: store.getKV<SimState>(bot.id, "paper"),
        persist: (state) => store.setKV(bot.id, "paper", state),
      });
    }
    // Strategies that trade on another exchange's lead (Taker Volume's smart timing) get
    // its prices next to SoDEX's.
    const reference = file.strategy.reference?.(file.config, checked.market.symbol);
    if (reference) exchange = withReference(exchange, new BinanceFeed(reference));

    const engine = new BotEngine({
      bot,
      strategy: file.strategy,
      config: file.config,
      exchange,
      store,
      risk: file.risk,
      onEvent: logEvent,
      ...(mode === "live" ? { deadManShared: () => otherLiveQuoterRunning(store, bot.id) } : {}),
      ...(STOP_WHEN_PAUSED_MS > 0 ? { stopWhenPausedMs: STOP_WHEN_PAUSED_MS } : {}),
    });
    const runner = new BotRunner(engine, {
      onError: (error) =>
        logEvent({
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    });

    console.log(
      `\n${c.bold(`Starting ${file.name}`)} [${mode}] — bot ${bot.id}, orders tagged ${engine.orderPrefix}*`,
    );
    console.log(
      c.dim(
        file.strategy.quoting
          ? "Ctrl+C cancels the quotes and disconnects; run the same command again to resume."
          : "Ctrl+C disconnects and leaves orders on the book; run the same command again to resume.",
      ),
    );
    await runner.start();
    started = true;
    // Show where things stand right away (a resumed bot often has nothing new to log).
    for (const line of describeBot(store, store.getBot(bot.id)!, engine.summary().mark)) {
      console.log(line);
    }
    console.log(c.dim("Running. A status line prints every minute; Ctrl+C to disconnect."));

    const statusTimer = setInterval(() => {
      const fresh = store.getBot(bot.id)!;
      for (const line of describeBot(store, fresh, engine.summary().mark)) console.log(c.dim(line));
    }, 60_000);

    await new Promise<void>((resolve) => {
      let closing = false;
      let handling = false;
      const shutdown = () => {
        if (closing || handling) return;
        closing = true;
        console.log("\nDisconnecting…");
        clearInterval(statusTimer);
        void runner.detach().finally(resolve);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      const watch = setInterval(() => {
        const command = takeCommand(store, bot.id);
        if (command && !handling) {
          handling = true;
          void runCommandFromDashboard(engine, command).finally(() => {
            handling = false;
          });
        }
        if (engine.status === "stopped" && !handling) {
          clearInterval(watch);
          shutdown();
        }
      }, 1_000);
    });

    const final = store.getBot(bot.id)!;
    store.endSession(
      session,
      Date.now(),
      final.status === "stopped" ? `stopped: ${final.statusReason ?? "stopped"}` : "disconnected",
    );
    for (const line of describeBot(store, final, engine.summary().mark)) console.log(line);
    if (final.status !== "stopped") {
      console.log(
        c.dim(
          `${file.strategy.quoting ? "Quotes were cancelled; the position (if any) stays." : "Orders stay on the book."} Resume: npm run bot -- ${mode} ${path}${mode === "live" ? " --confirm" : ""}   Stop: npm run bot -- stop ${path}${mode === "paper" ? " --paper" : ""}`,
        ),
      );
    }
    return 0;
  } finally {
    if (!started) store.dropSession(session);
    release();
    store.close();
  }
}

/**
 * Another live quoting bot on the same SoDEX account is running in some process.
 * SoDEX's dead-man switch covers the whole account, so it must stay armed for that bot.
 */
export function otherLiveQuoterRunning(store: SqliteStore, botId: string): boolean {
  const account = accountOf(store.getBot(botId) ?? {});
  return store
    .listBots()
    .some(
      (b) =>
        b.id !== botId &&
        accountOf(b) === account &&
        b.mode === "live" &&
        b.status !== "stopped" &&
        STRATEGIES[b.strategy]?.quoting === true &&
        lockHolder(b.id) !== undefined,
    );
}

/** A request from the dashboard API, left in the store for the process running the bot. */
export type BotCommand =
  { type: "stop"; close: boolean; at: number } | { type: "resume"; at: number };

/** Commands older than this are ignored (e.g. sent while no process was running the bot). */
const COMMAND_TTL_MS = 60_000;

export function takeCommand(store: SqliteStore, botId: string): BotCommand | undefined {
  const command = store.getKV<BotCommand | null>(botId, "command");
  if (!command) return undefined;
  store.setKV(botId, "command", null);
  return Date.now() - command.at <= COMMAND_TTL_MS ? command : undefined;
}

async function runCommandFromDashboard(
  engine: BotEngine<unknown, unknown>,
  command: BotCommand,
): Promise<void> {
  if (command.type === "resume") {
    engine.resume();
    return;
  }
  if (command.type !== "stop") {
    // Only an explicit stop stops the bot; a command this code does not know is ignored.
    logEvent({
      level: "warn",
      message: `Ignored an unknown dashboard command: ${String((command as { type?: unknown }).type)}`,
    });
    return;
  }
  try {
    await engine.stop({ closePosition: command.close, reason: "stopped from the dashboard" });
    if (command.close) {
      // Give the close order a moment, then pick up its fill (as `stop --close` does).
      await new Promise((r) => setTimeout(r, 3_000));
      await engine.reconcile();
    }
  } catch (error) {
    logEvent({
      level: "error",
      message: `Dashboard stop failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** The signing key is registered for this account and not about to expire. */
export async function checkApiKey(
  client: SodexClient,
  user: `0x${string}`,
  accountID: Uint64,
): Promise<void> {
  const signer = client.signer!;
  const keys = await client.user.apiKeys(user, { accountID, name: signer.apiKeyName });
  const key = keys.perps.find((k) => k.name === signer.apiKeyName);
  if (!key || key.publicKey.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `API key "${signer.apiKeyName}" is not registered for account ${accountID} with this private key`,
    );
  }
  if (key.expiresAt !== 0 && key.expiresAt < Date.now() + 24 * 3600_000) {
    throw new Error(`API key "${signer.apiKeyName}" expires within a day; renew it on sodex.com`);
  }
}

/**
 * A fresh run may start on a perps market where the account holds `account` only when that's
 * what is left of this bot's own last run (`own`: same side, no bigger), which it closes before
 * starting. Anything else is someone else's position (a trade by hand, another bot) and would
 * show as a drift the moment the bot traded.
 */
export function positionBlocksStart(own: string | undefined, account: string): boolean {
  const acc = toDecimal(account);
  if (acc.isZero()) return false;
  const mine = toDecimal(own ?? "0");
  return mine.isZero() || acc.isNegative() !== mine.isNegative() || acc.abs().gt(mine.abs());
}

/**
 * Refuse to start a fresh run (a new bot, or a stopped one started again) on a symbol where
 * the account has open orders or a position that isn't this bot's own leftover.
 */
async function guardLiveStart(
  client: SodexClient,
  user: `0x${string}`,
  accountID: Uint64,
  file: BotFile,
  bot: BotRecord,
  store: SqliteStore,
): Promise<void> {
  await checkApiKey(client, user, accountID);

  const saved = store.getKV<{ position?: { size?: string } }>(bot.id, "engine");
  const isNew = saved === undefined;
  // A resume (after a server restart) carries on its run: the account holds its position.
  if (!isNew && bot.status !== "stopped") return;
  const api = file.market === "perps" ? client.perps : client.spot;
  const open = await api.openOrders(user, { accountID, symbol: file.symbol });
  // This bot's own leftovers are tidied up when it starts.
  const own = botOrderPrefix(STRATEGIES[file.strategyName]?.idPrefix ?? "", bot.id);
  const others = open.orders.filter((o) => !o.clOrdID?.startsWith(own));
  if (others.length > 0) {
    throw new Error(
      `${file.symbol} already has ${others.length} open order(s) on this account. A bot needs the symbol to itself: cancel them on sodex.com, or stop the bot that placed them.`,
    );
  }
  if (file.market === "perps") {
    const positions = await client.perps.positions(user, { accountID });
    const pos = positions.positions.find(
      (p) => p.symbol === file.symbol && !toDecimal(p.size).isZero(),
    );
    if (pos && positionBlocksStart(saved?.position?.size, pos.size))
      throw new Error(
        `Close your open position first: your SoDEX account holds ${pos.size} on ${file.symbol}, a position this bot didn't open (a trade by hand, or another bot's). Close it on sodex.com, or stop the bot that holds it, then start again: a bot needs its market to itself.`,
      );
  }
}
