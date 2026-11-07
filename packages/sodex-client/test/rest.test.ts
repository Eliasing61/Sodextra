import { describe, expect, it, vi } from "vitest";
import { recoverAddress, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import {
  ActionSigner,
  HttpTransport,
  actionPayloadHash,
  exchangeActionDigest,
  NonceManager,
  OrderSide,
  OrderType,
  perpsNewOrder,
  SodexApiError,
  SodexClient,
  SodexHttpError,
  SodexNetworkError,
  TimeInForce,
  toRecoverableSignature,
  WeightLimiter,
} from "../src/index.ts";

const TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;

interface Captured {
  url: URL;
  init: RequestInit;
}

function mockFetch(body: string, init: ResponseInit = { status: 200 }) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (url: URL | RequestInfo, reqInit?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: reqInit ?? {} });
    return new Response(body, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("REST transport", () => {
  it("unwraps the envelope and keeps uint64 IDs exact", async () => {
    const { fetch, calls } = mockFetch(
      '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a","orderID":18446744073709551615}]}',
    );
    const client = new SodexClient({ network: "mainnet", fetch });
    const data = await client.perps.recentTrades("BTC-USD", 2);
    expect(data).toEqual([{ code: 0, clOrdID: "a", orderID: 18446744073709551615n }]);
    expect(calls[0]!.url.toString()).toBe(
      "https://mainnet-gw.sodex.dev/api/v1/perps/markets/BTC-USD/trades?limit=2",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("passes account filters as query params and skips undefined ones", async () => {
    const { fetch, calls } = mockFetch('{"code":0,"timestamp":1,"data":{"orders":[]}}');
    const client = new SodexClient({ network: "testnet", fetch });
    await client.perps.openOrders("0xabc0000000000000000000000000000000000001", { accountID: 42 });
    expect(calls[0]!.url.toString()).toBe(
      "https://testnet-gw.sodex.dev/api/v1/perps/accounts/0xabc0000000000000000000000000000000000001/orders?accountID=42",
    );
  });

  it("throws SodexApiError for error envelopes", async () => {
    const { fetch } = mockFetch('{"code":-1,"error":"nonce is invalid","timestamp":1}', {
      status: 400,
    });
    const client = new SodexClient({ network: "mainnet", fetch });
    await expect(client.perps.symbols()).rejects.toMatchObject({
      name: "SodexApiError",
      code: -1,
      apiMessage: "nonce is invalid",
    });
    await expect(client.perps.symbols()).rejects.toBeInstanceOf(SodexApiError);
  });

  it("throws SodexHttpError for non-envelope responses", async () => {
    const { fetch } = mockFetch("<html>bad gateway</html>", { status: 502 });
    const client = new SodexClient({ network: "mainnet", fetch });
    await expect(client.perps.symbols()).rejects.toBeInstanceOf(SodexHttpError);
  });

  it("marks failed writes as outcome-unknown", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("socket hang up");
    }) as unknown as typeof globalThis.fetch;
    const signer = new ActionSigner({ privateKey: TEST_KEY, apiKeyName: "bot" });
    const client = new SodexClient({ network: "mainnet", fetch, signer });
    const error = await client.perps
      .placeOrders({
        accountID: 1,
        symbolID: 1,
        orders: [{ clOrdID: "x", side: 1, type: 1, timeInForce: 4, price: "1", quantity: "1" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SodexNetworkError);
    expect((error as SodexNetworkError).outcomeUnknown).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); // a write is never retried
  });

  describe("read retries", () => {
    const OK = '{"code":0,"timestamp":1,"data":["ok"]}';
    /** Fails the first `failures` calls with `error`, then answers OK. */
    function flaky(failures: number, error: () => Error) {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls <= failures) throw error();
        return new Response(OK, { status: 200 });
      });
      const http = new HttpTransport({
        baseUrl: "https://example.test",
        limiter: new WeightLimiter(),
        fetch: fn as unknown as typeof fetch,
        retryDelaysMs: [0, 0],
      });
      return { http, fn };
    }
    const dropped = () => new TypeError("fetch failed");
    const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

    it("tries a read again after a dropped connection", async () => {
      const { http, fn } = flaky(2, dropped);
      await expect(http.request({ method: "GET", path: "/x", weight: 1 })).resolves.toEqual(["ok"]);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("gives up after three tries", async () => {
      const { http, fn } = flaky(3, dropped);
      await expect(http.request({ method: "GET", path: "/x", weight: 1 })).rejects.toBeInstanceOf(
        SodexNetworkError,
      );
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("tries a timed-out read only once more", async () => {
      const { http, fn } = flaky(2, timeout);
      await expect(http.request({ method: "GET", path: "/x", weight: 1 })).rejects.toBeInstanceOf(
        SodexNetworkError,
      );
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  it("feeds x-ratelimit headers into the weight limiter", async () => {
    const { fetch } = mockFetch('{"code":0,"timestamp":1,"data":[]}', {
      status: 200,
      headers: {
        "x-ratelimit-limit": "6000",
        "x-ratelimit-remaining": "5000",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
      },
    });
    const weightLimiter = new WeightLimiter();
    const client = new SodexClient({ network: "mainnet", fetch, weightLimiter });
    await client.perps.symbols();
    expect(weightLimiter.used).toBe(1000);
  });
});

describe("signed writes", () => {
  it("sends params as the body and a signature that recovers to the API key", async () => {
    const { fetch, calls } = mockFetch(
      '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"sx-1","orderID":99}]}',
    );
    const signer = new ActionSigner({ privateKey: TEST_KEY, apiKeyName: "bot-key" });
    const nonces = new NonceManager(() => 1760373925001);
    const client = new SodexClient({ network: "mainnet", fetch, signer, nonces });

    const input = {
      accountID: 12345,
      symbolID: 1,
      orders: [
        {
          clOrdID: "sx-1",
          side: OrderSide.BUY,
          type: OrderType.LIMIT,
          timeInForce: TimeInForce.GTX,
          price: "70000",
          quantity: "0.00015",
        },
      ],
    };
    const result = await client.perps.placeOrders(input);
    expect(result).toEqual([{ code: 0, clOrdID: "sx-1", orderID: 99 }]);

    const { url, init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url.pathname).toBe("/api/v1/perps/trade/orders");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      '{"accountID":12345,"symbolID":1,"orders":[{"clOrdID":"sx-1","modifier":1,"side":1,"type":1,"timeInForce":4,"price":"70000","quantity":"0.00015","reduceOnly":false,"positionSide":1}]}',
    );
    expect(headers["X-API-Key"]).toBe("bot-key");
    expect(headers["X-API-Nonce"]).toBe("1760373925001");
    expect(headers["X-API-Chain"]).toBe("286623");

    const digest = exchangeActionDigest(
      "perps",
      286623,
      actionPayloadHash(perpsNewOrder(input)),
      1760373925001n,
    );
    const recovered = await recoverAddress({
      hash: digest,
      signature: toRecoverableSignature(headers["X-API-Sign"] as Hex),
    });
    expect(recovered).toBe(privateKeyToAddress(TEST_KEY));
  });

  it("uses DELETE for cancels and the spot batch path for spot orders", async () => {
    const { fetch, calls } = mockFetch('{"code":0,"timestamp":1,"data":[]}');
    const client = new SodexClient({
      network: "mainnet",
      fetch,
      signer: new ActionSigner({ privateKey: TEST_KEY, apiKeyName: "k" }),
    });
    await client.perps.cancelOrders({ accountID: 1, cancels: [{ symbolID: 1, clOrdID: "a" }] });
    await client.spot.placeOrders({
      accountID: 1,
      orders: [
        { symbolID: 2, clOrdID: "b", side: 1, type: 1, timeInForce: 4, price: "1", quantity: "5" },
      ],
    });
    await client.spot.cancelOrders({
      accountID: 1,
      cancels: [{ symbolID: 2, clOrdID: "c", origClOrdID: "b" }],
    });
    expect(calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      "DELETE /api/v1/perps/trade/orders",
      "POST /api/v1/spot/trade/orders/batch",
      "DELETE /api/v1/spot/trade/orders/batch",
    ]);
  });

  it("omits X-API-Key when signing with the master wallet", async () => {
    const { fetch, calls } = mockFetch('{"code":0,"timestamp":1,"data":null}');
    const client = new SodexClient({
      network: "mainnet",
      fetch,
      signer: new ActionSigner({ privateKey: TEST_KEY }),
    });
    await client.perps.scheduleCancel({ accountID: 1 });
    expect(calls[0]!.init.headers).not.toHaveProperty("X-API-Key");
  });

  it("refuses to trade without a signer", async () => {
    const client = new SodexClient({ network: "mainnet", fetch: mockFetch("{}").fetch });
    await expect(client.perps.scheduleCancel({ accountID: 1 })).rejects.toThrow(/signer/);
  });
});

describe("null arrays from Go", () => {
  it("turns null slices in account responses into empty arrays", async () => {
    const { fetch } = mockFetch(
      '{"code":0,"timestamp":1,"data":{"aid":1061,"B":[],"O":null,"P":null,"TO":null,"DO":null,"S":null}}',
    );
    const client = new SodexClient({ network: "mainnet", fetch });
    const state = await client.perps.state("0x0000000000000000000000000000000000000001");
    expect(state.P).toEqual([]);
    expect(state.O).toEqual([]);
  });

  it("turns a null list body into an empty array", async () => {
    const { fetch } = mockFetch('{"code":0,"timestamp":1,"data":null}');
    const client = new SodexClient({ network: "mainnet", fetch });
    expect(await client.perps.orderHistory("0x0000000000000000000000000000000000000001")).toEqual(
      [],
    );
  });
});
