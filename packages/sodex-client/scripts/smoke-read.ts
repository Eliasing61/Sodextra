// Read-only smoke test against live SoDEX. Signs nothing and places no orders.
//   pnpm smoke:read
// With SODEX_USER_ADDRESS (and optionally the API key vars) in .env it also checks your account.

import { privateKeyToAddress } from "viem/accounts";

import { SodexClient, SodexWsClient, type WsPush } from "../src/index.ts";
import { env, finish, info, section, sleep, step } from "./lib.ts";

const client = new SodexClient({ network: env.network });
console.log(`SoDEX read-only smoke test — ${env.network}`);

section("Public market data (REST)");
const symbols = await step("perps symbols", async () => {
  const list = await client.perps.symbols();
  info(`${list.length} perps markets`);
  return list;
});
const btc = symbols?.find((s) => s.name === "BTC-USD");
if (btc)
  info(
    `BTC-USD: id ${btc.id}, tick ${btc.tickSize}, step ${btc.stepSize}, minNotional ${btc.minNotional}, max ${btc.maxLeverage}x`,
  );

await step("perps mark prices", async () => {
  const marks = await client.perps.markPrices();
  const m = marks.find((x) => x.symbol === "BTC-USD");
  if (!m) throw new Error("BTC-USD missing from mark prices");
  info(`BTC-USD mark ${m.markPrice}, index ${m.indexPrice}, funding ${m.fundingRate}/h`);
});
await step("perps order book", async () => {
  const book = await client.perps.orderbook("BTC-USD", 5);
  info(`best bid ${book.bids[0]?.[0]} / best ask ${book.asks[0]?.[0]}`);
});
await step("perps klines", async () => {
  const k = await client.perps.klines("BTC-USD", "1h", { limit: 3 });
  if (k.length === 0) throw new Error("no candles");
  info(`${k.length} hourly candles, last close ${k[0]?.c}`);
});
await step("spot symbols", async () => {
  const list = await client.spot.symbols();
  info(`${list.length} spot markets`);
});

section("Public market data (WebSocket)");
await step("perps markPrice stream", async () => {
  const pushes: WsPush[] = [];
  const ws = new SodexWsClient({
    network: env.network,
    engine: "perps",
    onSubscribeError: (_p, e) => info(`subscribe error: ${e}`),
  });
  ws.subscribe({ channel: "markPrice", symbols: ["BTC-USD"] }, (m) => pushes.push(m));
  ws.connect();
  const deadline = Date.now() + 15_000;
  while (pushes.length < 2 && Date.now() < deadline) await sleep(200);
  ws.close();
  if (pushes.length === 0) throw new Error("no messages within 15 s");
  info(`${pushes.length} pushes (${pushes.map((p) => p.type).join(", ")})`);
});

if (!env.userAddress) {
  section("Account checks skipped — set SODEX_USER_ADDRESS in .env to include them");
} else {
  const user = env.userAddress;
  section(`Account ${user}`);

  const subs = await step("subaccounts", async () => {
    const s = await client.user.subaccounts(user);
    info(`primary account ${s.primaryAccountID}, ${s.subaccounts.length} subaccount(s)`);
    return s;
  });
  const accountID = env.accountId ?? subs?.primaryAccountID;

  await step("perps account state", async () => {
    const s = await client.perps.state(user, accountID !== undefined ? { accountID } : {});
    const usdc = s.B.find((b) => b.a === "vUSDC");
    info(`account ${s.aid}: wallet ${usdc?.wb ?? "0"} vUSDC, available ${usdc?.aw ?? "0"}`);
    info(`${s.P.length} open position(s), ${s.O.length} open order(s)`);
    for (const p of s.P) info(`  ${p.s} size ${p.sz} @ ${p.ep} (${p.l}x ${p.m}), liq ${p.lp}`);
  });

  await step("spot balances", async () => {
    const b = await client.spot.balances(user, accountID !== undefined ? { accountID } : {});
    info(
      b.balances.length
        ? b.balances.map((x) => `${x.coin} ${x.total}`).join(", ")
        : "no spot balances",
    );
  });

  await step("action budget (address rate limit)", async () => {
    const r = await client.user.rateLimit(user);
    info(
      `${r.transactionQuotaRemaining} actions left of ${r.transactionQuota}; cancels left ${r.cancelQuotaRemaining}`,
    );
  });

  if (env.apiKeyName) {
    await step(`API key "${env.apiKeyName}" is registered on both engines`, async () => {
      const keys = await client.user.apiKeys(user, {
        ...(accountID !== undefined ? { accountID } : {}),
        name: env.apiKeyName,
      });
      const perps = keys.perps.find((k) => k.name === env.apiKeyName);
      const spot = keys.spot.find((k) => k.name === env.apiKeyName);
      if (!perps || !spot)
        throw new Error(`missing on ${!perps ? "perps" : ""} ${!spot ? "spot" : ""}`.trim());
      const expires = perps.expiresAt === 0 ? "never" : new Date(perps.expiresAt).toISOString();
      info(
        `public key ${perps.publicKey}, expires ${expires}, permissions mask ${perps.permissions ?? "none (all enabled)"}`,
      );
      if (perps.expiresAt !== 0 && perps.expiresAt < Date.now()) throw new Error("key has expired");
      if (env.apiKeyPrivateKey) {
        const derived = privateKeyToAddress(env.apiKeyPrivateKey).toLowerCase();
        if (derived !== perps.publicKey.toLowerCase()) {
          throw new Error(
            `SODEX_API_KEY_PRIVATE_KEY belongs to ${derived}, not the registered key`,
          );
        }
        info("private key in .env matches the registered key");
      }
    });
  }
}

finish();
