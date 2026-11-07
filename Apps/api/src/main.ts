/**
 * Local dashboard API. Reads the bots' state from .sodextra/sodextra.db (shared
 * with the CLI; SQLite WAL lets both use it at once) and serves it to the web app.
 * Stop requests are left in the store for the process running the bot; starts
 * launch the CLI as a background process (see launcher.ts).
 *
 *   GET  /bots              list
 *   GET  /bots/:id          full view (metrics, chart, orders, fills, events)
 *   POST /bots              { mode, confirm, file }  write bots/web/<name>.json and start it
 *   POST /bots/:id/start    { confirm }              start an existing bot again from its file
 *   POST /bots/:id/stop     { close }
 *   POST /bots/:id/resume   resume a paused bot
 *   GET  /sessions[?bot=id] past and current runs with their volume and cost
 *   GET  /stats/volume      total volume and fills of all live bots (public, no names)
 *   GET  /admin             owner only: server health, capacity, running bots and users
 *
 *   GET  /auth/nonce        one-time nonce for a sign-in message
 *   POST /auth/login        { message, signature }   wallet sign-in (EIP-4361) → session cookie
 *   POST /auth/logout
 *   GET  /auth/me           the signed-in address, or 401
 *
 *   GET  /keys              the owner's bot keys (no secrets) and where bots sign from
 *   POST /keys/prepare      new trade-only key, sealed in the vault; returns the message to sign
 *   POST /keys/:id/register { signature }  register it on SoDEX with the owner's signature
 *   POST /keys/:id/test     place and cancel a far-from-market order with it
 *
 * Everything except /auth/* and /stats/volume needs a signed-in session from an allowed wallet
 * (docs/security.md). Listens on 127.0.0.1 only; the web app reaches it through its
 * /api proxy. Writes must be JSON from the web app's origin.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { uptime } from "node:os";
import { join } from "node:path";

import { loadBotFile } from "@sodextra/cli/bot-file";
import {
  accountOf,
  DATA_DIR,
  DB_PATH,
  env,
  LOCK_DIR,
  serverAccount,
  VAULT_PATH,
} from "@sodextra/cli/env";
import { KeyVault } from "@sodextra/cli/vault";
import { lockHolder } from "@sodextra/cli/lock";
import { SqliteStore, type BotRecord } from "@sodextra/engine-core";
import { SodexClient } from "@sodextra/sodex-client";

import { inviteOnlyMessage, isOwner, lockedFor, mayRun, webCreateBlock } from "./access.ts";
import { adminBots, serverStats } from "./admin.ts";
import { Auth } from "./auth.ts";
import {
  approvalNeeded,
  builderStatus,
  launchFee,
  prepareApproval,
  submitApproval,
  type BuilderStatus,
} from "./builder.ts";
import { CARRY_LEG } from "./carry-view.ts";
import {
  addressLoad,
  CONNECTIONS_PER_ADDRESS,
  egressPool,
  pickAddress,
  USERS_PER_ADDRESS,
  type AddressUse,
} from "./egress.ts";
import { freeShortfall, marginNeed } from "./funds.ts";
import { checkActiveKey, prepareKey, publicKey, registerKey, testKey } from "./keys.ts";
import { launchBot, writeWebBotFile } from "./launcher.ts";
import { PROFIT_PERIODS, profitView } from "./profit.ts";
import { kept } from "./kept.ts";
import { MarkCache } from "./marks.ts";
import { listProcesses, lockedPids, orphanBots } from "./orphans.ts";
import { fits, slotsFor } from "./slots.ts";
import { spotBlock, spots } from "./spots.ts";
import { botsToResume } from "./resume.ts";
import { sharedMarketBlock } from "./shared-market.ts";
import type { AdminView, CommandResult, ProfitPeriod, StartResult } from "./types.ts";
import { botTypeStats, botView, listItem, sessionViews, type ViewContext } from "./views.ts";

const PORT = Number(process.env.SODEXTRA_API_PORT ?? 3101);
const WEB_ORIGINS = new Set(
  (process.env.SODEXTRA_WEB_ORIGIN ?? "http://localhost:3100,http://127.0.0.1:3100").split(","),
);
/** Host headers we answer (direct, or forwarded by the web app's proxy); blocks DNS rebinding. */
const HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...[...WEB_ORIGINS].map((o) => new URL(o).host),
]);

const PROXY_SECRET = process.env.SODEXTRA_PROXY_SECRET?.trim() || undefined;
if (PROXY_SECRET && PROXY_SECRET.length < 32) {
  throw new Error("SODEXTRA_PROXY_SECRET must be at least 32 characters (openssl rand -hex 32)");
}

/**
 * The server's addresses bots send SoDEX traffic from (egress.ts); none = the default one.
 * SoDEX allows 10 users and 10 connections per address, and the API holds none.
 */
const EGRESS = egressPool(process.env.SODEXTRA_EGRESS_IPS);
const ADDRESSES = Math.max(1, EGRESS.length);
/** Bots one wallet may run at once, and SoDEX connections in use on this server. */
const MAX_BOTS_PER_USER = Number(process.env.SODEXTRA_MAX_BOTS_PER_USER ?? 3);
const MAX_RUNNING_BOTS = Number(
  process.env.SODEXTRA_MAX_RUNNING_BOTS ?? CONNECTIONS_PER_ADDRESS * ADDRESSES,
);
/**
 * Early access (temporary, spots.ts): people who may run bots at once, the owner included
 * (10 per address), and how many bots each of the others may run meanwhile (the owner keeps
 * MAX_BOTS_PER_USER).
 */
const RUN_SPOTS = Number(process.env.SODEXTRA_RUN_SPOTS ?? USERS_PER_ADDRESS * ADDRESSES);
const MAX_BOTS_PER_GUEST = Number(process.env.SODEXTRA_MAX_BOTS_PER_GUEST ?? 1);

// Fails closed: without an allowed address (or * for anyone) the API doesn't start.
const auth = new Auth({
  dbPath: join(DATA_DIR, "auth.db"),
  allowed: (process.env.SODEXTRA_ALLOWED_ADDRESSES?.trim() || env.userAddress || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean),
  origins: [...WEB_ORIGINS],
  secureCookie: process.env.SODEXTRA_COOKIE_SECURE !== "false",
});

const store = new SqliteStore(DB_PATH);
const publicClient = new SodexClient({ network: env.network });

// The key vault is optional: without SODEXTRA_VAULT_KEY, bots keep using the .env key.
const vaultKey = KeyVault.masterKeyFromEnv(process.env.SODEXTRA_VAULT_KEY);
const vault = vaultKey ? new KeyVault({ dbPath: VAULT_PATH, masterKey: vaultKey }) : undefined;
const marks = new MarkCache(publicClient);

function context(): ViewContext {
  return {
    now: Date.now(),
    mark: (bot: BotRecord) => marks.get(bot.market, bot.symbol),
    online: (id: string) => lockHolder(id) !== undefined,
  };
}

/**
 * Volume and fills of every live bot on this server, all time, and the real results of each
 * bot type: open to visitors (the landing page, New bot). Kept and recomputed at most once a
 * minute, after answering (kept.ts): adding up every bot holds the server for a moment, and
 * no visitor should wait for it.
 */
const totals = kept(() => {
  const ctx = context();
  const live = store.listBots().filter((b) => b.mode === "live");
  // A Funding Carry bot's volume already includes its legs; its fills are the legs' own.
  const volume = live
    .filter((b) => b.strategy !== CARRY_LEG)
    .reduce((sum, b) => sum + listItem(store, b, ctx).volume, 0);
  const fills = live.reduce((sum, b) => sum + store.fillStats(b.id).count, 0);
  return { volume, fills };
}, 60_000);
const typeStats = kept(async () => {
  const bots = store.listBots().filter((b) => b.mode === "live");
  await marks.refresh(withLegMarkets(bots));
  return botTypeStats(store, context());
}, 60_000);

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * The website's /api proxy proves itself with a shared secret (SODEXTRA_PROXY_SECRET),
 * needed when the website runs elsewhere (Vercel) and reaches this API through Caddy.
 * Without a secret configured, only local callers on our own Host get in (see handle).
 */
function fromProxy(req: IncomingMessage): boolean {
  if (!PROXY_SECRET) return false;
  const given = Buffer.from(String(req.headers["x-sodextra-proxy"] ?? ""));
  const want = Buffer.from(PROXY_SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Who is calling, for rate limits: the visitor's address as the website's proxy reports it. */
function clientOf(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const trusted = PROXY_SECRET ? fromProxy(req) : loopback;
  const reported = String(req.headers["x-sodextra-client"] ?? "").trim();
  return trusted && reported ? reported : remote;
}

async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  action: string | undefined,
): Promise<void> {
  if (req.method === "GET" && action === "nonce")
    return send(res, 200, { nonce: auth.issueNonce() });
  if (req.method === "GET" && action === "me") {
    const address = auth.session(req.headers.cookie);
    return address ? send(res, 200, { address }) : send(res, 401, { error: "signed out" });
  }
  if (req.method === "POST" && action === "login") {
    const body = await readJson(req);
    const result = await auth.signIn(
      String(body.message ?? ""),
      String(body.signature ?? ""),
      clientOf(req),
    );
    if (!result.ok) return send(res, 401, { ok: false, message: result.reason });
    return send(
      res,
      200,
      { ok: true, address: result.address },
      {
        "set-cookie": auth.cookie(result.token, result.expiresAt),
      },
    );
  }
  if (req.method === "POST" && action === "logout") {
    auth.signOut(req.headers.cookie);
    return send(res, 200, { ok: true }, { "set-cookie": auth.clearCookie() });
  }
  send(res, 404, { error: "not found" });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 10_000) throw new Error("body too large");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Reject cross-site writes: browsers send Origin on cross-site POSTs, and JSON forces a preflight we never approve. */
function writeAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const json = (req.headers["content-type"] ?? "").startsWith("application/json");
  return json && origin !== undefined && WEB_ORIGINS.has(origin);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (PROXY_SECRET) {
    if (!fromProxy(req)) return send(res, 403, { error: "forbidden" });
  } else if (!HOSTS.has(req.headers.host ?? "")) {
    return send(res, 403, { error: "bad host" });
  }
  if (req.method !== "GET" && !writeAllowed(req)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "auth" && parts.length === 2) return handleAuth(req, res, parts[1]);

  // The landing page's Sodextra volume and fills: two numbers, open to everyone.
  if (req.method === "GET" && url.pathname === "/stats/volume")
    return send(res, 200, await totals());

  // Real results of each bot type across every live bot on this server (totals, no names
  // or wallets): open to visitors browsing New bot.
  if (req.method === "GET" && url.pathname === "/stats/bot-types")
    return send(res, 200, await typeStats());

  // Everything below needs a signed-in, allowed wallet, except /access for visitors.
  const owner = auth.session(req.headers.cookie);
  if (!owner && req.method === "GET" && url.pathname === "/access") {
    // A visitor: every invite-only bot locked, and the spots left.
    return send(res, 200, {
      locked: lockedFor(""),
      spots: spots(runningAccounts(), isOwner, RUN_SPOTS),
      hasSpot: false,
      maxBots: MAX_BOTS_PER_GUEST,
    });
  }
  if (!owner) return send(res, 401, { error: "sign in" });

  if (parts[0] === "keys") return handleKeys(req, res, parts.slice(1), owner);

  // Sodextra's builder fee: whether this wallet must approve it, and the approval itself.
  if (parts[0] === "builder") {
    if (req.method === "GET" && parts.length === 1) {
      try {
        return send(res, 200, await builderStatus(publicClient, owner));
      } catch (error) {
        return send(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (req.method === "POST" && parts[1] === "prepare") {
      try {
        return send(res, 200, { ok: true, ...(await prepareApproval(publicClient, owner)) });
      } catch (error) {
        return send(res, 200, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (req.method === "POST" && parts[1] === "approve") {
      const body = await readJson(req);
      const signature = String(body.signature ?? "");
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
        return send(res, 400, { ok: false, message: ODD_SIGNATURE });
      return send(res, 200, await submitApproval(publicClient, owner, signature as `0x${string}`));
    }
  }

  // Bot types this wallet can't run (invite-only ones), so the website can lock them.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "access") {
    const running = runningAccounts();
    return send(res, 200, {
      locked: lockedFor(owner),
      // Early access: spots left for people to run a bot, and whether this wallet holds one.
      spots: spots(running, isOwner, RUN_SPOTS),
      hasSpot: isOwner(owner) || running.has(owner.toLowerCase()),
      maxBots: isOwner(owner) ? MAX_BOTS_PER_USER : MAX_BOTS_PER_GUEST,
    });
  }

  // Owner only, read-only: server health, capacity, and who is running what. Others get 404.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "admin") {
    if (!isOwner(owner)) return send(res, 404, { error: "not found" });
    const bots = store.listBots().filter((b) => b.mode === "live" && b.strategy !== CARRY_LEG);
    await marks.refresh(withLegMarkets(bots));
    const ctx = context();
    const { running, users, slotsUsed } = adminBots(
      bots.map((b) => ({ account: accountOf(b) ?? "", item: listItem(store, b, ctx) })),
    );
    const view: AdminView = {
      asOf: Date.now(),
      server: serverStats(DATA_DIR),
      capacity: {
        slotsUsed,
        maxSlots: MAX_RUNNING_BOTS,
        maxPerUser: MAX_BOTS_PER_USER,
        maxPerGuest: MAX_BOTS_PER_GUEST,
        usersRunning: users.filter((u) => u.running > 0).length,
        maxUsers: USERS_PER_ADDRESS * ADDRESSES,
        spots: spots(runningAccounts(), isOwner, RUN_SPOTS),
        addresses: EGRESS.length ? addressLoad(EGRESS, addressUses()) : [],
      },
      running,
      users,
      access: { signIn: auth.open ? "anyone" : auth.allowed.length },
    };
    return send(res, 200, view);
  }

  // A Funding Carry bot's legs are part of it, not bots of their own.
  const mine = (bot: BotRecord | undefined): bot is BotRecord =>
    bot !== undefined && accountOf(bot) === owner.toLowerCase() && bot.strategy !== CARRY_LEG;

  if (req.method === "GET" && parts.length === 1 && parts[0] === "sessions") {
    const botId = url.searchParams.get("bot");
    const bots = botId ? [store.getBot(botId)].filter(mine) : store.listBots().filter(mine);
    return send(res, 200, sessionViews(store, bots, context()));
  }

  if (req.method === "POST" && parts.length === 1 && parts[0] === "bots") {
    const body = await readJson(req);
    // Only the bot types the website offers (not probes or carry legs), whatever the request says.
    const file = typeof body.file === "object" && body.file !== null ? body.file : undefined;
    const notWeb = file && webCreateBlock(String((file as Record<string, unknown>).strategy ?? ""));
    if (notWeb) return send(res, 400, { ok: false, message: notWeb });
    return send(res, 200, await createAndStart(body, owner));
  }

  if (req.method === "GET" && parts.length === 1 && parts[0] === "bots") {
    const bots = store.listBots().filter(mine);
    await marks.refresh(withLegMarkets(bots));
    const ctx = context();
    return send(
      res,
      200,
      bots.map((b) => listItem(store, b, ctx)),
    );
  }

  if (parts[0] === "bots" && parts[1]) {
    const bot = store.getBot(parts[1]);
    if (!mine(bot)) return send(res, 404, { error: "no such bot" });

    if (req.method === "GET" && parts.length === 2) {
      await marks.refresh(withLegMarkets([bot]));
      return send(res, 200, botView(store, bot, context()));
    }

    if (req.method === "GET" && parts.length === 3 && parts[2] === "profit") {
      const asked = url.searchParams.get("period") as ProfitPeriod | null;
      const period = asked && PROFIT_PERIODS.includes(asked) ? asked : "run";
      return send(res, 200, profitView(store, bot, period));
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "start") {
      const body = await readJson(req);
      return send(res, 200, await startExisting(bot, body.confirm === true));
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "resume") {
      return send(res, 200, requestResume(bot));
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "stop") {
      const body = await readJson(req);
      return send(res, 200, requestStop(bot, body.close === true));
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "remove") {
      return send(res, 200, removeFromList(bot));
    }
  }

  send(res, 404, { error: "not found" });
}

/**
 * A signature that isn't a plain 65-byte one: smart-contract wallets (Safe, smart accounts)
 * sign differently, and SoDEX only takes a regular wallet's signature.
 */
const ODD_SIGNATURE =
  "Your wallet signed in a way SoDEX can't use. Smart-contract wallets (like Safe or a smart account) can't sign for SoDEX: use a regular wallet such as MetaMask, Rabby or Trust.";

async function handleKeys(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  owner: `0x${string}`,
): Promise<void> {
  // Every wallet manages its own keys; the .env key only shows for the server's own account.
  if (req.method === "GET" && rest.length === 0) {
    // A key deleted on sodex.com stops counting as active (and Setup offers a new one).
    if (vault) await checkActiveKey(vault, publicClient, owner);
    return send(res, 200, {
      vault: vault !== undefined,
      keys: vault ? vault.list(owner).map(publicKey) : [],
      active: vault?.activeFor(owner)?.id ?? null,
      envKey: owner.toLowerCase() === serverAccount ? (env.apiKeyName ?? null) : null,
    });
  }
  if (!vault) {
    return send(res, 503, {
      ok: false,
      message:
        "The key vault isn't set up. Run npm run vault:key and add SODEXTRA_VAULT_KEY to .env.",
    });
  }
  if (req.method === "POST" && rest.length === 1 && rest[0] === "prepare") {
    try {
      return send(res, 200, { ok: true, ...(await prepareKey(vault, publicClient, owner)) });
    } catch (error) {
      return send(res, 200, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (req.method === "POST" && rest.length === 2 && rest[1] === "register") {
    const body = await readJson(req);
    const signature = String(body.signature ?? "");
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return send(res, 400, { ok: false, message: ODD_SIGNATURE });
    }
    return send(
      res,
      200,
      await registerKey(vault, publicClient, owner, rest[0]!, signature as `0x${string}`),
    );
  }
  if (req.method === "POST" && rest.length === 2 && rest[1] === "test") {
    try {
      return send(res, 200, await testKey(vault, env.network, owner, rest[0]!));
    } catch (error) {
      return send(res, 200, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  send(res, 404, { error: "not found" });
}

function requestResume(bot: BotRecord): CommandResult {
  if (bot.status !== "paused") return { ok: false, message: "The bot isn't paused." };
  if (lockHolder(bot.id) === undefined) {
    return { ok: false, message: "No process is running this bot. Use Resume to start it again." };
  }
  store.setKV(bot.id, "command", { type: "resume", at: Date.now() });
  return { ok: true, message: "Resuming…" };
}

function requestStop(bot: BotRecord, close: boolean): CommandResult {
  if (bot.status === "stopped") return { ok: false, message: "The bot is already stopped." };
  if (lockHolder(bot.id) === undefined) {
    return {
      ok: false,
      message: `No process is running this bot. Stop it from the CLI: npm run bot -- stop <bot file>${bot.mode === "paper" ? " --paper" : ""}`,
    };
  }
  store.setKV(bot.id, "command", { type: "stop", close, at: Date.now() });
  return {
    ok: true,
    message: close ? "Stopping and closing the position…" : "Stopping and cancelling quotes…",
  };
}

/** Wallets with a bot running right now (each holds a run spot), leaving out one bot. */
function runningAccounts(exceptId?: string): Set<string> {
  return new Set(
    store
      .listBots()
      .filter(
        (b) => b.id !== exceptId && b.strategy !== CARRY_LEG && lockHolder(b.id) !== undefined,
      )
      .map((b) => accountOf(b))
      .filter((a): a is string => a !== undefined),
  );
}

async function createAndStart(
  body: Record<string, unknown>,
  owner: `0x${string}`,
): Promise<StartResult> {
  const mode = body.mode;
  if (mode !== "paper" && mode !== "live")
    return { ok: false, message: 'mode must be "paper" or "live"' };
  if (mode === "live" && body.confirm !== true) {
    return { ok: false, message: "A live start needs an explicit confirmation." };
  }
  if (typeof body.file !== "object" || body.file === null) {
    return { ok: false, message: "Missing bot file." };
  }
  const strategy = String((body.file as Record<string, unknown>).strategy ?? "");
  if (!mayRun(strategy, owner)) return { ok: false, message: inviteOnlyMessage(strategy) };
  let path: string;
  try {
    // The bot trades the signed-in wallet's account, whatever the request says.
    const file = { ...(body.file as Record<string, unknown>) };
    delete file.owner;
    if (owner.toLowerCase() !== serverAccount) file.owner = owner.toLowerCase();
    path = writeWebBotFile(file);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return start(path, mode);
}

/** Bot states that may come off the dashboard's list: not running and not about to. */
const REMOVABLE = new Set(["stopped", "created", "error"]);

/**
 * Take a stopped bot off the dashboard's list. Nothing is deleted: its runs, trades and
 * events stay in History and the totals, and starting it again (or a new bot of the same
 * name) brings it back.
 */
function removeFromList(bot: BotRecord): CommandResult {
  if (lockHolder(bot.id) !== undefined || !REMOVABLE.has(bot.status))
    return { ok: false, message: "Stop the bot first." };
  store.setKV(bot.id, "hidden", true);
  return { ok: true, message: "Removed from your bots. Its history stays." };
}

async function startExisting(bot: BotRecord, confirm: boolean): Promise<StartResult> {
  if (bot.mode !== "paper" && bot.mode !== "live") {
    return { ok: false, message: "Only paper and live bots can be started." };
  }
  if (lockHolder(bot.id) !== undefined)
    return { ok: false, message: "The bot is already running." };
  if (!mayRun(bot.strategy, accountOf(bot)))
    return { ok: false, message: inviteOnlyMessage(bot.strategy) };
  if (bot.mode === "live" && !confirm) {
    return { ok: false, message: "A live start needs an explicit confirmation." };
  }
  const path = store.getKV<string>(bot.id, "file");
  if (!path) {
    return {
      ok: false,
      message:
        "This bot was last started before the dashboard could start bots. Start it once from the terminal.",
    };
  }
  return start(path, bot.mode);
}

/** Funding Carry bots also hold spot: refresh spot prices too. */
function withLegMarkets(bots: BotRecord[]): { market: "spot" | "perps" }[] {
  return bots.some((b) => b.strategy === "carry") ? [...bots, { market: "spot" }] : bots;
}

/**
 * Refuse a start, with the figures, when the perps account's free margin can't cover this
 * bot (the bot's own start check would stop it right after launch; skipped when it resumes,
 * since its own position uses the margin). Live bots of one wallet also share its account:
 * refuse when it can't cover every running bot's worst-case margin plus the new one
 * (otherwise quotes start failing with "insufficient margin" once positions grow).
 */
async function marginCheck(
  config: unknown,
  market: string,
  account: string | undefined,
  selfId: string | undefined,
  resuming: boolean,
): Promise<string | undefined> {
  if (!account || market === "spot") return undefined;
  const others = store
    .listBots()
    .filter(
      (b) =>
        b.mode === "live" &&
        b.id !== selfId &&
        b.strategy !== CARRY_LEG &&
        accountOf(b) === account &&
        lockHolder(b.id) !== undefined,
    );
  const need = marginNeed(config);
  const othersNeed = others.reduce((sum, b) => sum + marginNeed(b.config, b.market), 0);
  if (need === 0) return undefined;
  let state: { av: string; am?: string | undefined };
  try {
    state = await publicClient.perps.state(account as `0x${string}`);
  } catch {
    return undefined; // the bot's own start check still runs
  }
  const short = resuming ? undefined : freeShortfall(config, market, Number(state.am ?? 0));
  if (short) return short;
  if (others.length === 0) return undefined;
  const value = Number(state.av);
  if (need + othersNeed <= value) return undefined;
  const names = others.map((b) => b.name).join(", ");
  return (
    `Not enough balance for another bot: ${names} already need up to ${othersNeed.toFixed(2)} of margin, ` +
    `this one needs ${need.toFixed(2)}, and the account has ${value.toFixed(2)}. ` +
    `Use higher leverage (Advanced settings), smaller quotes, stop a bot, or deposit more.`
  );
}

/**
 * A spot bot buys with the USDC in the wallet's SoDEX spot account (perps balance doesn't
 * count): refuse a start it couldn't fund, as its own start check would right after
 * launch (skipped when it resumes: the coins it holds came from that USDC).
 */
async function spotCheck(
  config: unknown,
  market: string,
  account: string | undefined,
  resuming: boolean,
): Promise<string | undefined> {
  if (!account || market !== "spot" || resuming) return undefined;
  let free: number;
  try {
    const { balances } = await publicClient.spot.balances(account as `0x${string}`);
    const usdc = balances.find((b) => b.coin === "vUSDC");
    free = usdc ? Number(usdc.total) - Number(usdc.locked) : 0;
  } catch {
    return undefined; // the bot's own checks still run
  }
  return freeShortfall(config, "spot", free);
}

/** The wallet's builder fee status (undefined when SoDEX can't be asked). */
async function feeStatus(account: string | undefined): Promise<BuilderStatus | undefined> {
  if (!account) return undefined;
  return builderStatus(publicClient, account as `0x${string}`).catch(() => undefined);
}

/** The wallet hasn't approved Sodextra's builder fee (SoDEX unreachable: let the start through). */
function approvalBlock(status: BuilderStatus | undefined): string | undefined {
  return status?.required && !status.approved ? approvalNeeded(status) : undefined;
}

/** Why this account can't start another bot right now, if it can't. */
function startBlocked(
  account: string | undefined,
  selfId: string | undefined,
  strategy: string,
): string | undefined {
  if (!account) return "This server has no account for this bot.";
  const running = store
    .listBots()
    .filter((b) => b.id !== selfId && b.strategy !== CARRY_LEG && lockHolder(b.id) !== undefined);
  const maxBots = isOwner(account) ? MAX_BOTS_PER_USER : MAX_BOTS_PER_GUEST;
  if (running.filter((b) => accountOf(b) === account).length >= maxBots) {
    return maxBots === 1
      ? "During early access you can run 1 bot at a time. Stop it first to start another."
      : `You can run up to ${maxBots} bots at once. Stop one first.`;
  }
  const spotFull = spotBlock(account, runningAccounts(selfId), isOwner, RUN_SPOTS);
  if (spotFull) return spotFull;
  // The limit counts SoDEX connections (10 per server IP): a Funding Carry bot holds two.
  if (
    !fits(
      running.map((b) => b.strategy),
      strategy,
      MAX_RUNNING_BOTS,
    )
  ) {
    return slotsFor(strategy) > 1
      ? "The server doesn't have room for a Funding Carry bot right now (it needs two connections to SoDEX). Try again later."
      : "The server is at its limit of running bots right now. Try again later.";
  }
  const vaultKey = vault?.activeFor(account as `0x${string}`);
  if (!vaultKey && !(account === serverAccount && env.apiKeyName)) {
    return "Create your bot key in Setup first.";
  }
  return undefined;
}

/** Where the running bots' SoDEX traffic leaves from, and what each uses there. */
function addressUses(selfId?: string): AddressUse[] {
  return store
    .listBots()
    .filter((b) => b.id !== selfId && b.strategy !== CARRY_LEG && lockHolder(b.id) !== undefined)
    .map((b) => ({
      address: store.getKV<string | null>(b.id, "egress") ?? undefined,
      account: accountOf(b),
      live: b.mode === "live",
      connections: slotsFor(b.strategy),
    }));
}

/** Bots being launched, by owner/name/mode: they hold their address before they record it. */
const launching = new Map<string, AddressUse>();

async function start(
  path: string,
  mode: "paper" | "live",
  note?: string,
  needApproval = true,
): Promise<StartResult> {
  const file = loadBotFile(path);
  const { name, owner } = file;
  const existing = store.findBot(name, mode, owner);
  if (existing && lockHolder(existing.id) !== undefined) {
    return { ok: false, message: `"${name}" is already running (${mode}).` };
  }
  // Started again (by name or from its page): back on the dashboard's list.
  if (existing && store.getKV<boolean>(existing.id, "hidden") === true)
    store.setKV(existing.id, "hidden", false);
  const account = accountOf({ owner });
  // Sodextra's fee status for this wallet (live bots): checked below, and sets the bot's fee.
  let fee: BuilderStatus | undefined;
  // Was running (a restart or a disconnect): its own position already uses the balance.
  const resuming =
    existing !== undefined && existing.status !== "stopped" && existing.status !== "created";
  if (mode === "live") {
    // The wallet's other live bots running now (carry legs included: they trade too).
    const sharing = store
      .listBots()
      .filter(
        (b) =>
          b.mode === "live" &&
          b.id !== existing?.id &&
          accountOf(b) === account &&
          lockHolder(b.id) !== undefined,
      );
    fee = await feeStatus(account);
    const needsFee = needApproval ? approvalBlock(fee) : undefined;
    const blocked =
      startBlocked(account, existing?.id, file.strategyName) ??
      sharedMarketBlock(
        { strategy: file.strategyName, market: file.market, symbol: file.symbol },
        sharing,
      ) ??
      needsFee ??
      (await spotCheck(file.config, file.market, account, resuming)) ??
      (await marginCheck(file.config, file.market, account, existing?.id, resuming));
    if (blocked) {
      return {
        ok: false,
        message: blocked,
        ...(blocked === needsFee && fee
          ? { approval: { fee: fee.fee, approvedFee: fee.approvedFee } }
          : {}),
      };
    }
  }
  // The address this bot's SoDEX traffic leaves from (10 people and 10 connections each).
  const key = `${owner ?? ""}/${name}/${mode}`;
  let egress: string | undefined;
  if (EGRESS.length > 0) {
    const use = { account, live: mode === "live", connections: slotsFor(file.strategyName) };
    egress = pickAddress(EGRESS, [...addressUses(existing?.id), ...launching.values()], use);
    if (!egress) {
      return {
        ok: false,
        message:
          use.connections > 1
            ? "The server doesn't have room for a Funding Carry bot right now (it needs two connections to SoDEX). Try again later."
            : "The server is at its limit of running bots right now. Try again later.",
      };
    }
    launching.set(key, { address: egress, ...use });
  }
  try {
    const result = await launchBot({
      path,
      mode,
      ...(note ? { note } : {}),
      env: {
        ...(egress ? { SODEXTRA_EGRESS_IP: egress } : {}),
        // This bot's builder fee: a restart by itself keeps what its user approved.
        ...(mode === "live" ? { SODEXTRA_BUILDER_FEE: String(launchFee(fee, !needApproval)) } : {}),
      },
      isRunning: (pid) => {
        const bot = store.findBot(name, mode, owner);
        return bot !== undefined && lockHolder(bot.id) === pid;
      },
    });
    return { ...result, botId: store.findBot(name, mode, owner)?.id };
  } finally {
    launching.delete(key);
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

/**
 * After a reboot, start again the bots that were running when the machine went
 * down (resume.ts). Opt-in: on a desktop, a reboot shouldn't start trading.
 */
async function resumeAfterReboot(): Promise<void> {
  const bootTime = Date.now() - uptime() * 1000;
  const candidates = botsToResume(store, {
    bootTime,
    online: (id) => lockHolder(id) !== undefined,
  });
  for (const { bot, path, openSession } of candidates) {
    if (openSession) store.endSession(openSession.id, bootTime, "server restarted");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const mode = bot.mode as "paper" | "live";
      // A bot that was running keeps running; the fee approval is asked for at the next start.
      const result = await start(path, mode, "resumed after a server restart", false);
      console.log(`Auto-resume ${bot.name} (${mode}), attempt ${attempt}: ${result.message}`);
      if (result.ok) break;
      if (result.log) console.log(result.log);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Sodextra API on http://127.0.0.1:${PORT} (db ${DB_PATH})`);
  console.log("The web app (npm run web) reads it through /api. Ctrl+C to stop.");
  // Ready before the first visitor asks.
  totals().catch(() => undefined);
  typeStats().catch(() => undefined);
  if (process.env.SODEXTRA_AUTO_RESUME === "1") {
    resumeAfterReboot().catch((error: unknown) => {
      console.error("Auto-resume failed:", error instanceof Error ? error.message : error);
    });
  }
});

setInterval(() => auth.prune(), 3600_000).unref();

// Bot processes left running without their bot (orphans.ts): every 5 minutes, stop the ones
// that already held no lock at the previous check, with their helper processes (esbuild).
let lockless = new Set<number>();
setInterval(() => {
  const processes = listProcesses();
  const found = orphanBots(processes, lockedPids(LOCK_DIR));
  for (const p of found) {
    if (!lockless.has(p.pid)) continue;
    for (const pid of [...processes.filter((c) => c.ppid === p.pid).map((c) => c.pid), p.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    console.warn(`Stopped leftover bot process ${p.pid} (no lock): ${p.args.slice(-3).join(" ")}`);
  }
  lockless = new Set(found.map((p) => p.pid));
}, 5 * 60_000).unref();

const shutdown = () => {
  server.close();
  auth.close();
  vault?.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
