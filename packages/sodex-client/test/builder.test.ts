import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  approveBuilderFeeTypedData,
  canonicalJson,
  OrderSide,
  OrderType,
  perpsNewOrder,
  spotBatchNewOrder,
  TimeInForce,
} from "../src/index.ts";

const WALLET = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

describe("builder codes", () => {
  it("builds ApproveBuilderFeeAction in SoDEX's field order, and a wallet signature verifies", async () => {
    const typed = approveBuilderFeeTypedData({
      chainId: 286623,
      nonce: 1793520000000n,
      accountID: 2042,
      builderID: 1061,
      maxFeeRate: 1,
    });
    expect(typed.domain).toMatchObject({ name: "universal", version: "1", chainId: 286623 });
    expect(typed.types.ApproveBuilderFeeAction.map((f) => f.name)).toEqual([
      "chainID",
      "nonce",
      "accountID",
      "builderID",
      "maxFeeRate",
    ]);
    const signature = await WALLET.signTypedData(typed);
    expect(await verifyTypedData({ address: WALLET.address, ...typed, signature })).toBe(true);
  });

  it("puts the builder last in a perps batch and a spot batch (part of the signed payload)", () => {
    const order = {
      clOrdID: "sxm-test-1",
      side: OrderSide.BUY,
      type: OrderType.LIMIT,
      timeInForce: TimeInForce.GTX,
      price: "100",
      quantity: "0.1",
    };
    const perps = canonicalJson(
      perpsNewOrder({
        accountID: 2042,
        symbolID: 1,
        orders: [order],
        builder: { id: 1061, fee: 1 },
      }).params,
    );
    expect(perps.endsWith(`"builder":{"id":1061,"fee":1}}`)).toBe(true);
    const spot = canonicalJson(
      spotBatchNewOrder({
        accountID: 2042,
        orders: [{ ...order, symbolID: 30 }],
        builder: { id: 1061, fee: 1 },
      }).params,
    );
    expect(spot.endsWith(`"builder":{"id":1061,"fee":1}}`)).toBe(true);
    // No builder: the field is left out, as SoDEX requires.
    expect(
      canonicalJson(perpsNewOrder({ accountID: 2042, symbolID: 1, orders: [order] }).params),
    ).not.toContain("builder");
  });
});
