import { describe, expect, it } from "vitest";
import {
  concatHex,
  keccak256,
  numberToHex,
  padHex,
  recoverAddress,
  recoverTypedDataAddress,
  stringToBytes,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

import {
  ActionSigner,
  actionPayloadHash,
  addApiKeyTypedData,
  addPermissionedApiKeyTypedData,
  canonicalJson,
  exchangeActionDigest,
  NETWORKS,
  OrderSide,
  OrderType,
  perpsCancelOrder,
  perpsNewOrder,
  scheduleCancel,
  spotBatchCancelOrder,
  spotBatchNewOrder,
  TimeInForce,
  toRecoverableSignature,
  replaceOrder,
  SignatureType,
  walletToWireSignature,
} from "../src/index.ts";

// Well-known test key from the SoDEX Python/Go SDK test suites. Never holds funds.
const TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const CHAIN = NETWORKS.mainnet.chainId;

// ── Independent port of the Go SDK hashing (common/types/eip712.go) ───────────
// Used to cross-check viem's EIP-712 implementation byte for byte.
const u = (n: bigint | number) => padHex(numberToHex(BigInt(n)), { size: 32 });
const kstr = (s: string) => keccak256(stringToBytes(s));

function goDomainSeparator(name: string, chainId: number): Hex {
  return keccak256(
    concatHex([
      kstr("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      kstr(name),
      kstr("1"),
      u(chainId),
      padHex("0x00", { size: 32 }),
    ]),
  );
}

function goDigest(domainName: string, chainId: number, structHash: Hex): Hex {
  return keccak256(concatHex(["0x1901", goDomainSeparator(domainName, chainId), structHash]));
}

function goExchangeActionDigest(domainName: string, payloadHash: Hex, nonce: bigint): Hex {
  const structHash = keccak256(
    concatHex([kstr("ExchangeAction(bytes32 payloadHash,uint64 nonce)"), payloadHash, u(nonce)]),
  );
  return goDigest(domainName, CHAIN, structHash);
}

describe("canonical payloads", () => {
  it("matches the docs' perps market-order signing payload byte for byte", () => {
    const action = perpsNewOrder({
      accountID: 12345,
      symbolID: 1,
      orders: [
        {
          clOrdID: "my-order-1",
          side: OrderSide.BUY,
          type: OrderType.MARKET,
          timeInForce: TimeInForce.IOC,
          quantity: "0.001",
        },
      ],
    });
    expect(canonicalJson(action)).toBe(
      '{"type":"newOrder","params":{"accountID":12345,"symbolID":1,"orders":[{"clOrdID":"my-order-1","modifier":1,"side":1,"type":2,"timeInForce":3,"quantity":"0.001","reduceOnly":false,"positionSide":1}]}}',
    );
  });

  it("orders perps order fields like the Go struct and canonicalises decimals", () => {
    const action = perpsNewOrder({
      accountID: 7,
      symbolID: 1,
      orders: [
        {
          clOrdID: "a",
          side: OrderSide.SELL,
          type: OrderType.LIMIT,
          timeInForce: TimeInForce.GTX,
          price: "77500.00",
          quantity: "0.000490",
          reduceOnly: true,
        },
      ],
    });
    expect(canonicalJson(action.params)).toBe(
      '{"accountID":7,"symbolID":1,"orders":[{"clOrdID":"a","modifier":1,"side":2,"type":1,"timeInForce":4,"price":"77500","quantity":"0.00049","reduceOnly":true,"positionSide":1}]}',
    );
  });

  it("omits the builder unless given, and puts it last with id before fee", () => {
    const base = {
      accountID: 1,
      symbolID: 1,
      orders: [{ clOrdID: "x", side: 1, type: 1, timeInForce: 1, price: "1", quantity: "1" }],
    } as const;
    expect(
      canonicalJson(perpsNewOrder({ ...base, orders: [...base.orders] }).params),
    ).not.toContain("builder");
    const withBuilder = canonicalJson(
      perpsNewOrder({ ...base, orders: [...base.orders], builder: { id: 456, fee: 50 } }).params,
    );
    expect(withBuilder.endsWith(',"builder":{"id":456,"fee":50}}')).toBe(true);
  });

  it("serialises spot batch orders, spot cancels and perps cancels in Go field order", () => {
    expect(
      canonicalJson(
        spotBatchNewOrder({
          accountID: 9,
          orders: [
            {
              symbolID: 2,
              clOrdID: "s1",
              side: 1,
              type: 1,
              timeInForce: 4,
              price: "2236.10",
              quantity: "0.0050",
            },
          ],
        }),
      ),
    ).toBe(
      '{"type":"batchNewOrder","params":{"accountID":9,"orders":[{"symbolID":2,"clOrdID":"s1","side":1,"type":1,"timeInForce":4,"price":"2236.1","quantity":"0.005"}]}}',
    );
    expect(
      canonicalJson(
        spotBatchCancelOrder({
          accountID: 9,
          cancels: [{ symbolID: 2, clOrdID: "c1", origClOrdID: "s1" }],
        }),
      ),
    ).toBe(
      '{"type":"batchCancelOrder","params":{"accountID":9,"cancels":[{"symbolID":2,"clOrdID":"c1","origClOrdID":"s1"}]}}',
    );
    expect(
      canonicalJson(perpsCancelOrder({ accountID: 9, cancels: [{ symbolID: 1, orderID: 123n }] })),
    ).toBe(
      '{"type":"cancelOrder","params":{"accountID":9,"cancels":[{"symbolID":1,"orderID":123}]}}',
    );
    expect(
      canonicalJson(
        replaceOrder({
          accountID: 9,
          orders: [{ symbolID: 1, clOrdID: "r2", origClOrdID: "r1", price: "10.50" }],
        }),
      ),
    ).toBe(
      '{"type":"replaceOrder","params":{"accountID":9,"orders":[{"symbolID":1,"clOrdID":"r2","origClOrdID":"r1","price":"10.5"}]}}',
    );
    expect(canonicalJson(scheduleCancel({ accountID: 9 }))).toBe(
      '{"type":"scheduleCancel","params":{"accountID":9}}',
    );
  });

  it("keeps uint64 precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(canonicalJson({ id: 18446744073709551615n })).toBe('{"id":18446744073709551615}');
  });

  it("rejects floats, bad clOrdIDs, ambiguous cancels and empty or oversized batches", () => {
    expect(() => canonicalJson({ price: 0.1 })).toThrow();
    expect(() => perpsCancelOrder({ accountID: 1, cancels: [{ symbolID: 1 }] })).toThrow();
    expect(() =>
      perpsCancelOrder({ accountID: 1, cancels: [{ symbolID: 1, orderID: 1, clOrdID: "x" }] }),
    ).toThrow();
    const order = { clOrdID: "bad id!", side: 1, type: 1, timeInForce: 1 } as const;
    expect(() => perpsNewOrder({ accountID: 1, symbolID: 1, orders: [order] })).toThrow(/clOrdID/);
    expect(() => perpsNewOrder({ accountID: 1, symbolID: 1, orders: [] })).toThrow(/empty/);
    const many = Array.from({ length: 101 }, (_, i) => ({ ...order, clOrdID: `o${i}` }));
    expect(() => perpsNewOrder({ accountID: 1, symbolID: 1, orders: many })).toThrow(/100/);
  });

  it("escapes strings the way Go's json.Marshal does", () => {
    expect(canonicalJson({ s: 'a<b>& \n"\\' })).toBe(
      '{"s":"a\\u003cb\\u003e\\u0026\\u2028\\n\\"\\\\"}',
    );
  });
});

describe("EIP-712 trading signatures", () => {
  const action = perpsNewOrder({
    accountID: 12345,
    symbolID: 1,
    orders: [{ clOrdID: "my-order-1", side: 1, type: 2, timeInForce: 3, quantity: "0.001" }],
  });

  it("viem's digest equals the Go SDK hashing for both engine domains", () => {
    const payloadHash = actionPayloadHash(action);
    expect(payloadHash).toBe(keccak256(toBytes(canonicalJson(action))));
    for (const [engine, name] of [
      ["perps", "futures"],
      ["spot", "spot"],
    ] as const) {
      expect(exchangeActionDigest(engine, CHAIN, payloadHash, 1760373925001n)).toBe(
        goExchangeActionDigest(name, payloadHash, 1760373925001n),
      );
    }
  });

  it("produces a 66-byte 0x01-prefixed signature with v in {0,1} that recovers the signer", async () => {
    const signer = new ActionSigner({ privateKey: TEST_KEY, apiKeyName: "api-key-01" });
    const nonce = 1760373925001n;
    const sig = await signer.signAction("perps", CHAIN, action, nonce);

    expect(sig).toMatch(/^0x01[0-9a-f]{130}$/);
    expect(["00", "01"]).toContain(sig.slice(-2));
    const digest = exchangeActionDigest("perps", CHAIN, actionPayloadHash(action), nonce);
    expect(await recoverAddress({ hash: digest, signature: toRecoverableSignature(sig) })).toBe(
      privateKeyToAddress(TEST_KEY),
    );
  });

  it("is deterministic and bound to engine, nonce and params", async () => {
    const signer = new ActionSigner({ privateKey: TEST_KEY });
    const a = await signer.signAction("perps", CHAIN, action, 5n);
    expect(await signer.signAction("perps", CHAIN, action, 5n)).toBe(a);
    expect(await signer.signAction("spot", CHAIN, action, 5n)).not.toBe(a);
    expect(await signer.signAction("perps", CHAIN, action, 6n)).not.toBe(a);
    expect(await signer.signAction("perps", NETWORKS.testnet.chainId, action, 5n)).not.toBe(a);
  });

  it("never exposes the private key when serialised", () => {
    const signer = new ActionSigner({ privateKey: TEST_KEY, apiKeyName: "k" });
    expect(JSON.stringify(signer)).not.toContain(TEST_KEY.slice(2));
    expect(signer.address).toBe(privateKeyToAddress(TEST_KEY));
  });
});

describe("EIP-712 account-level (universal) actions", () => {
  const publicKey = "0x3d4595c8742d0a58173a9963c05755b59a8f8256" as const;

  it("AddAPIKey typed data hashes like the Go SDK", async () => {
    const td = addApiKeyTypedData({
      chainId: CHAIN,
      nonce: 1760373925000n,
      accountID: 1010,
      name: "api-key-01",
      publicKey,
      expiresAt: 0,
    });
    const structHash = keccak256(
      concatHex([
        kstr(
          "AddAPIKey(uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 nonce)",
        ),
        u(1010),
        kstr("api-key-01"),
        u(1),
        keccak256(publicKey),
        u(0),
        u(1760373925000n),
      ]),
    );
    const { hashTypedData } = await import("viem");
    expect(hashTypedData(td)).toBe(goDigest("universal", CHAIN, structHash));
  });

  it("permissioned AddAPIKey typed data hashes like the Go SDK and signs with prefix 0x02", async () => {
    const td = addPermissionedApiKeyTypedData({
      chainId: CHAIN,
      nonce: 1760373925000n,
      accountID: 1010,
      name: "bot-key",
      publicKey,
      expiresAt: 1800000000000,
      permissions: 14,
    });
    const structHash = keccak256(
      concatHex([
        kstr(
          "UserSignedAddPermissionedAPIKeyAction(uint64 chainID,uint64 nonce,uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 permissions)",
        ),
        u(CHAIN),
        u(1760373925000n),
        u(1010),
        kstr("bot-key"),
        u(1),
        keccak256(publicKey),
        u(1800000000000),
        u(14),
      ]),
    );
    const { hashTypedData } = await import("viem");
    expect(hashTypedData(td)).toBe(goDigest("universal", CHAIN, structHash));

    const sig = await new ActionSigner({ privateKey: TEST_KEY }).signUniversal(td);
    expect(sig).toMatch(/^0x02[0-9a-f]{130}$/);
  });
});

describe("permissioned API key registration signature", () => {
  it("turns a wallet's typed-data signature into SoDEX wire format that recovers to the wallet", async () => {
    const wallet = privateKeyToAccount(`0x${"33".repeat(32)}`);
    const typed = addPermissionedApiKeyTypedData({
      chainId: 286623,
      nonce: 1_793_431_000_000n,
      accountID: 1061,
      name: "sodextra-test",
      publicKey: "0x1523ef5c20fff7e8e91b5755713f58a2035bd1c4",
      expiresAt: 1_800_000_000_000,
      permissions: 14,
    });
    const walletSig = await wallet.signTypedData(typed);
    const wire = walletToWireSignature(walletSig, SignatureType.EIP712_UNIVERSAL);
    expect(wire.slice(0, 4)).toBe("0x02");
    expect(wire).toHaveLength(2 + 66 * 2);
    expect(["00", "01"]).toContain(wire.slice(-2));
    const recovered = await recoverTypedDataAddress({
      ...typed,
      signature: toRecoverableSignature(wire),
    });
    expect(recovered).toBe(wallet.address);
  });
});
