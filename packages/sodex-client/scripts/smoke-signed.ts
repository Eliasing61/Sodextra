// Signed smoke test on live SoDEX, using the API key in .env. Proves that our
// signing, nonces and request formats are accepted by the real gateway.
//
//   pnpm smoke:signed -- --confirm            perps: place a post-only order 3% below market, then cancel it
//   pnpm smoke:signed -- --confirm --spot     also the same on spot (needs ≥ 6 vUSDC in your spot account)
//   pnpm smoke:signed -- --confirm --fill     also a minimum-size market buy + reduce-only close on perps
//                                             (costs roughly two taker fees on ~$10, about $0.01)
//
// The default run never fills: the order rests away from the market and is cancelled.

import {
  OrderSide,
  OrderType,
  SodexClient,
  TimeInForce,
  checkOrder,
  minQuantityForNotional,
  roundPrice,
  toDecimal,
  type Address,
  type BatchItemResult,
  type MarketSymbol,
} from "../src/index.ts";
import { env, eventually, finish, info, makeSigner, section, sleep, step } from "./lib.ts";

const args = new Set(process.argv.slice(2));
const PERPS_SYMBOL = "BTC-USD";
const SPOT_SYMBOL = "vETH_vUSDC";

if (!args.has("--confirm")) {
  console.log(`This places REAL orders on SoDEX ${env.network} with the API key in .env:
  • perps ${PERPS_SYMBOL}: post-only buy ~3% below market at minimum size, then cancel (no fill)${
    args.has("--spot") ? `\n  • spot ${SPOT_SYMBOL}: the same` : ""
  }${args.has("--fill") ? `\n  • perps ${PERPS_SYMBOL}: minimum-size market buy, then reduce-only market sell (≈ $0.01 in fees)` : ""}
Re-run with --confirm to go ahead.`);
  process.exit(0);
}
if (!env.userAddress) throw new Error("Set SODEX_USER_ADDRESS in .env");

const user: Address = env.userAddress;
const signer = makeSigner();
const client = new SodexClient({ network: env.network, signer });
const runId = Date.now().toString(36);
console.log(
  `SoDEX signed smoke test — ${env.network}, key "${signer.apiKeyName}" (${signer.address})`,
);

section("Setup");
const accountID =
  env.accountId ??
  (await step("resolve account ID", async () => {
    const s = await client.perps.state(user);
    info(`account ${s.aid}`);
    return s.aid;
  }));
if (accountID === undefined) {
  finish();
  process.exit(1);
}

await step("API key is registered for this account and matches the private key", async () => {
  const keys = await client.user.apiKeys(user, { accountID, name: signer.apiKeyName });
  for (const engine of ["perps", "spot"] as const) {
    const key = keys[engine].find((k) => k.name === signer.apiKeyName);
    if (!key) throw new Error(`key not found on ${engine}`);
    if (key.publicKey.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`${engine}: registered public key ${key.publicKey} ≠ ${signer.address}`);
    }
    if (key.expiresAt !== 0 && key.expiresAt < Date.now())
      throw new Error(`${engine}: key expired`);
  }
});

function expectAccepted(results: BatchItemResult[], what: string): BatchItemResult {
  const r = results[0];
  if (!r) throw new Error(`${what}: empty response`);
  if (r.code !== 0) throw new Error(`${what} rejected (code ${r.code}): ${r.error ?? "no reason"}`);
  return r;
}

function restingBuy(symbol: MarketSymbol, reference: string) {
  const price = roundPrice(symbol, toDecimal(reference).mul(0.97), "down");
  const quantity = minQuantityForNotional(symbol, price);
  return { price, quantity };
}

// ── Perps: place post-only away from market, confirm, cancel, confirm ────────
section(`Perps ${PERPS_SYMBOL}: place + cancel (no fill)`);
const perpsSymbol = (await client.perps.symbols()).find((s) => s.name === PERPS_SYMBOL);
const mark = (await client.perps.markPrices()).find((m) => m.symbol === PERPS_SYMBOL);
if (!perpsSymbol || !mark) throw new Error(`${PERPS_SYMBOL} not found`);

const perpsOrder = restingBuy(perpsSymbol, mark.markPrice);
const perpsClOrdID = `sx-smoke-${runId}-p`;
info(`mark ${mark.markPrice} → post-only BUY ${perpsOrder.quantity} @ ${perpsOrder.price}`);

const problems = checkOrder(perpsSymbol, {
  side: OrderSide.BUY,
  type: OrderType.LIMIT,
  ...perpsOrder,
  markPrice: mark.markPrice,
});
if (problems.length) throw new Error(`Order fails local checks: ${problems.join("; ")}`);

const placed = await step("place post-only order (signed POST)", async () => {
  const r = expectAccepted(
    await client.perps.placeOrders({
      accountID,
      symbolID: perpsSymbol.id,
      orders: [
        {
          clOrdID: perpsClOrdID,
          side: OrderSide.BUY,
          type: OrderType.LIMIT,
          timeInForce: TimeInForce.GTX,
          ...perpsOrder,
        },
      ],
    }),
    "place",
  );
  info(`orderID ${r.orderID}`);
  return r;
});

if (placed) {
  await sleep(1500);
  await step("order is visible in open orders", async () => {
    const open = await client.perps.openOrders(user, { accountID, symbol: PERPS_SYMBOL });
    const o = open.orders.find((x) => x.clOrdID === perpsClOrdID);
    if (!o) throw new Error("not found among open orders");
    info(`status ${o.status}, ${o.side} ${o.origQty} @ ${o.price}, tif ${o.timeInForce}`);
  });

  // Atomic replace: what the maker bot uses to move quotes.
  let liveClOrdID = perpsClOrdID;
  const movedPrice = roundPrice(
    perpsSymbol,
    toDecimal(perpsOrder.price).minus(toDecimal(perpsSymbol.tickSize).mul(10)),
    "down",
  );
  const replaced = await step(`replace to ${movedPrice} in one action (signed POST)`, async () => {
    const newId = `${perpsClOrdID}-r`;
    expectAccepted(
      await client.perps.replaceOrders({
        accountID,
        orders: [
          {
            symbolID: perpsSymbol.id,
            clOrdID: newId,
            origClOrdID: perpsClOrdID,
            price: movedPrice,
          },
        ],
      }),
      "replace",
    );
    return newId;
  });
  if (replaced) {
    await step("replacement is live at the new price, original is gone", () =>
      eventually(async () => {
        const open = await client.perps.openOrders(user, { accountID, symbol: PERPS_SYMBOL });
        const next = open.orders.find((x) => x.clOrdID === replaced);
        if (!next) throw new Error("replacement not among open orders");
        if (!toDecimal(next.price ?? "0").eq(movedPrice))
          throw new Error(`replacement price is ${next.price}`);
        if (open.orders.some((x) => x.clOrdID === perpsClOrdID))
          throw new Error("original still open");
        info(
          `${next.clOrdID} ${next.side} ${next.origQty} @ ${next.price}, tif ${next.timeInForce}`,
        );
      }),
    );
    liveClOrdID = replaced;
  }

  await step("cancel by clOrdID (signed DELETE)", async () => {
    expectAccepted(
      await client.perps.cancelOrders({
        accountID,
        cancels: [{ symbolID: perpsSymbol.id, clOrdID: liveClOrdID }],
      }),
      "cancel",
    );
  });

  await step("order is gone and history shows CANCELED", () =>
    eventually(async () => {
      const open = await client.perps.openOrders(user, { accountID, symbol: PERPS_SYMBOL });
      if (open.orders.some((x) => x.clOrdID === liveClOrdID)) throw new Error("still open");
      const history = await client.perps.orderHistory(user, {
        accountID,
        symbol: PERPS_SYMBOL,
        limit: 20,
      });
      const h = history.find((x) => x.clOrdID === liveClOrdID);
      if (!h) throw new Error("not in recent history after 20 s");
      if (h.status !== "CANCELED") throw new Error(`history status is ${h.status}`);
    }),
  );
}

// ── Dead-man switch (scheduleCancel), armed and cleared ─────────────────────
section("Perps dead-man switch");
await step("arm schedule-cancel 60 s ahead", async () => {
  await client.perps.scheduleCancel({ accountID, scheduledTimestamp: Date.now() + 60_000 });
});
await step("clear it again", async () => {
  await client.perps.scheduleCancel({ accountID });
});

// ── Spot (optional) ───────────────────────────────────────────────────────────
if (args.has("--spot")) {
  section(`Spot ${SPOT_SYMBOL}: place + cancel (no fill)`);
  const spotSymbol = (await client.spot.symbols()).find((s) => s.name === SPOT_SYMBOL);
  const book = await client.spot.orderbook(SPOT_SYMBOL, 1);
  const bestBid = book.bids[0]?.[0];
  if (!spotSymbol || !bestBid) throw new Error(`${SPOT_SYMBOL} not available`);

  const order = restingBuy(spotSymbol, bestBid);
  const clOrdID = `sx-smoke-${runId}-s`;
  info(`best bid ${bestBid} → post-only BUY ${order.quantity} @ ${order.price}`);

  const ok = await step("place post-only order", async () =>
    expectAccepted(
      await client.spot.placeOrders({
        accountID,
        orders: [
          {
            symbolID: spotSymbol.id,
            clOrdID,
            side: OrderSide.BUY,
            type: OrderType.LIMIT,
            timeInForce: TimeInForce.GTX,
            ...order,
          },
        ],
      }),
      "place",
    ),
  );
  if (ok) {
    await sleep(1500);
    await step("cancel by origClOrdID", async () => {
      expectAccepted(
        await client.spot.cancelOrders({
          accountID,
          cancels: [{ symbolID: spotSymbol.id, clOrdID: `${clOrdID}-c`, origClOrdID: clOrdID }],
        }),
        "cancel",
      );
    });
    await sleep(1500);
    await step("order is gone", () =>
      eventually(async () => {
        const open = await client.spot.openOrders(user, { accountID, symbol: SPOT_SYMBOL });
        if (open.orders.some((x) => x.clOrdID === clOrdID)) throw new Error("still open");
      }),
    );
  }
}

// ── Fill round trip (optional) ────────────────────────────────────────────────
if (args.has("--fill")) {
  section(`Perps ${PERPS_SYMBOL}: minimum-size fill and close`);
  const before = await client.perps.positions(user, { accountID });
  if (before.positions.some((p) => p.symbol === PERPS_SYMBOL && !toDecimal(p.size).isZero())) {
    throw new Error(`You already have a ${PERPS_SYMBOL} position; skipping the fill test`);
  }
  const qty = minQuantityForNotional(perpsSymbol, toDecimal(mark.markPrice).mul(0.99));
  const buyId = `sx-smoke-${runId}-fb`;
  const sellId = `sx-smoke-${runId}-fs`;

  const bought = await step(`market BUY ${qty}`, async () =>
    expectAccepted(
      await client.perps.placeOrders({
        accountID,
        symbolID: perpsSymbol.id,
        orders: [
          {
            clOrdID: buyId,
            side: OrderSide.BUY,
            type: OrderType.MARKET,
            timeInForce: TimeInForce.IOC,
            quantity: qty,
          },
        ],
      }),
      "market buy",
    ),
  );
  if (bought) {
    await sleep(2000);
    await step(`reduce-only market SELL ${qty}`, async () =>
      expectAccepted(
        await client.perps.placeOrders({
          accountID,
          symbolID: perpsSymbol.id,
          orders: [
            {
              clOrdID: sellId,
              side: OrderSide.SELL,
              type: OrderType.MARKET,
              timeInForce: TimeInForce.IOC,
              quantity: qty,
              reduceOnly: true,
            },
          ],
        }),
        "reduce-only sell",
      ),
    );
    await sleep(2000);
    await step("both fills recorded, position flat", async () => {
      const mine = await eventually(async () => {
        const trades = await client.perps.userTrades(user, {
          accountID,
          symbol: PERPS_SYMBOL,
          limit: 20,
        });
        const fills = trades.filter((t) => t.clOrdID === buyId || t.clOrdID === sellId);
        if (!fills.some((t) => t.clOrdID === buyId) || !fills.some((t) => t.clOrdID === sellId)) {
          throw new Error("expected fills for both orders within 20 s");
        }
        return fills;
      });
      for (const t of mine)
        info(
          `${t.side} ${t.quantity} @ ${t.price}, fee ${t.fee ?? "?"} (builder ${t.builderFee ?? "0"})`,
        );
      const after = await client.perps.positions(user, { accountID });
      const open = after.positions.find(
        (p) => p.symbol === PERPS_SYMBOL && !toDecimal(p.size).isZero(),
      );
      if (open) throw new Error(`position not flat: ${open.size}`);
    });
  }
}

finish();
